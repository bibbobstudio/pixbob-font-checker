(() => {
  const $ = (s) => document.querySelector(s);
  const input = $('#font-input'), dropzone = $('#dropzone'), grid = $('#glyph-grid');
  const state = { font: null, glyphs: [], objectUrl: null, axes: [], mode: 'vector', bitmap: null, saved: { vector: null, bitmap: null } };
  const formatSize = (bytes) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  const clean = (value) => value || '—';
  const fontName = (names, key) => names?.[key]?.en || names?.[key]?.['en-US'] || Object.values(names?.[key] || {})[0] || '';
  const unicode = (n) => `U+${n.toString(16).toUpperCase().padStart(4, '0')}`;

  let noticeTimer;
  function showNotice(message, type = 'error') {
    const notice = $('#app-notice'); clearTimeout(noticeTimer); notice.textContent = message; notice.className = `app-notice ${type}`; notice.hidden = false;
    noticeTimer = setTimeout(() => { notice.hidden = true; }, 6000);
  }

  const attributes = (text) => Object.fromEntries([...text.matchAll(/([\w-]+)=("[^"]*"|'[^']*'|[^\s]+)/g)].map(match => [match[1], match[2].replace(/^['"]|['"]$/g, '')]));
  function bitmapMetadata(text, extension) {
    if (extension === 'json') { const data = JSON.parse(text); return { pages: data.pages || data.page || [], chars: (data.chars || data.characters || []).map(item => ({ id: Number(item.id ?? item.char), x: Number(item.x), y: Number(item.y), width: Number(item.width), height: Number(item.height), xoffset: Number(item.xoffset || 0), yoffset: Number(item.yoffset || 0), xadvance: Number(item.xadvance ?? item.width), page: Number(item.page || 0) })), lineHeight: Number(data.common?.lineHeight || data.lineHeight || 16), name: data.info?.face || data.face || 'Bitmap Font' }; }
    if (extension === 'xml') { const doc = new DOMParser().parseFromString(text, 'text/xml'); const common = doc.querySelector('common'); return { pages: [...doc.querySelectorAll('page')].map(node => node.getAttribute('file')), chars: [...doc.querySelectorAll('char')].map(node => { const item = Object.fromEntries([...node.attributes].map(attribute => [attribute.name, attribute.value])); return { id: Number(item.id), x: Number(item.x), y: Number(item.y), width: Number(item.width), height: Number(item.height), xoffset: Number(item.xoffset || 0), yoffset: Number(item.yoffset || 0), xadvance: Number(item.xadvance ?? item.width), page: Number(item.page || 0) }; }), lineHeight: Number(common?.getAttribute('lineHeight') || 16), name: doc.querySelector('info')?.getAttribute('face') || 'Bitmap Font' }; }
    const page = text.match(/^page\s+.*$/m)?.[0]; const common = text.match(/^common\s+.*$/m)?.[0]; const info = text.match(/^info\s+.*$/m)?.[0]; return { pages: page ? [attributes(page).file] : [], chars: text.split(/\r?\n/).filter(line => /^char\s/.test(line)).map(line => { const item = attributes(line); return { id: Number(item.id), x: Number(item.x), y: Number(item.y), width: Number(item.width), height: Number(item.height), xoffset: Number(item.xoffset || 0), yoffset: Number(item.yoffset || 0), xadvance: Number(item.xadvance ?? item.width), page: Number(item.page || 0) }; }), lineHeight: Number(common ? attributes(common).lineHeight : 16), name: info ? attributes(info).face || 'Bitmap Font' : 'Bitmap Font' };
  }

  function captureInfo() { return { family: $('#family-name').textContent, subfamily: $('#subfamily-name').textContent, format: $('#font-format').textContent, size: $('#font-size').textContent, glyphs: $('#glyph-count').textContent, upm: $('#units-per-em').textContent, tester: $('#tester-font-label').textContent, dialogTitle: $('#dialog-title').textContent, dialog: $('#full-metadata').innerHTML }; }
  function restoreInfo(info) { if (!info) return; $('#family-name').textContent = info.family; $('#subfamily-name').textContent = info.subfamily; $('#font-format').textContent = info.format; $('#font-size').textContent = info.size; $('#glyph-count').textContent = info.glyphs; $('#units-per-em').textContent = info.upm; $('#tester-font-label').textContent = info.tester; $('#dialog-title').textContent = info.dialogTitle; $('#full-metadata').innerHTML = info.dialog; $('.empty-info').hidden = true; $('.metadata').hidden = false; }

  function setMode(mode) {
    if (state.mode === 'vector' && state.font) state.saved.vector = { font: state.font, glyphs: state.glyphs, axes: state.axes, info: captureInfo() };
    if (state.mode === 'bitmap' && state.bitmap) state.saved.bitmap = { bitmap: state.bitmap, glyphs: state.glyphs, info: captureInfo() };
    state.mode = mode; const saved = state.saved[mode]; state.font = saved?.font || null; state.bitmap = saved?.bitmap || null; state.glyphs = saved?.glyphs || []; state.axes = saved?.axes || []; grid.innerHTML = '';
    $('#vector-mode').classList.toggle('active', mode === 'vector'); $('#bitmap-mode').classList.toggle('active', mode === 'bitmap');
    input.accept = '.ttf,.otf,.woff,.woff2,.zip,font/ttf,font/otf,font/woff,font/woff2,application/zip,application/x-zip-compressed';
    $('#upload-title').textContent = mode === 'vector' ? 'DROP VECTOR FONT' : 'DROP BITMAP FONT ZIP'; $('#upload-copy').textContent = mode === 'vector' ? 'or click to choose a file' : 'ZIP with FNT, JSON, or XML and PNG atlas'; $('.dropzone small').textContent = mode === 'vector' ? '.TTF  .OTF  .WOFF  .WOFF2' : '.ZIP ONLY';
    $('#original-color-input').closest('label').hidden = mode !== 'bitmap';
    $('#test-preview').hidden = mode === 'bitmap'; $('#bitmap-test-canvas').hidden = mode !== 'bitmap';
    if (state.font || state.bitmap) { restoreInfo(saved.info); $('#empty-state').hidden = true; $('#health-button').disabled = false; filterGlyphs(); if (mode === 'bitmap') renderBitmapPreview(); else setupVariations(); runHealthCheck(); } else { $('#empty-state').hidden = false; $('#glyph-title').textContent = mode === 'vector' ? 'Ready to inspect' : 'Upload a bitmap font ZIP'; $('#health-button').disabled = true; $('#health-results').hidden = true; $('#health-summary').textContent = 'WAITING'; }
  }

  function readVariableAxes(buffer) {
    const view = new DataView(buffer); let offset = 0;
    const tagAt = (position) => String.fromCharCode(view.getUint8(position), view.getUint8(position + 1), view.getUint8(position + 2), view.getUint8(position + 3));
    const fixed = (position) => view.getInt32(position) / 65536;
    if (tagAt(0) === 'wOFF') return [];
    const tableCount = view.getUint16(4);
    for (let index = 0; index < tableCount; index += 1) { const record = 12 + index * 16; if (tagAt(record) === 'fvar') { offset = view.getUint32(record + 8); break; } }
    if (!offset || offset + 16 > view.byteLength) return [];
    const dataOffset = view.getUint16(offset + 4), axisCount = view.getUint16(offset + 8), axisSize = view.getUint16(offset + 10);
    if (axisSize < 16 || !axisCount) return [];
    return Array.from({ length: axisCount }, (_, index) => { const at = offset + dataOffset + index * axisSize; return { tag: tagAt(at), min: fixed(at + 4), value: fixed(at + 8), max: fixed(at + 12) }; });
  }

  async function decompressWoff2(buffer) {
    if (location.protocol === 'file:') throw new Error('WOFF2 decoding needs a local web server. Open this checker through localhost or its deployed website.');
    try {
      const decoder = await import('./assets/woff2/decompress.js');
      const output = await decoder.default(buffer);
      return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
    } catch (error) {
      throw new Error(`WOFF2 decoder failed: ${error.message || 'the file could not be decompressed.'}`);
    }
  }

  function setupVariations() {
    const panel = $('#variation-panel'), holder = $('#variation-controls');
    panel.hidden = !state.axes.length; holder.innerHTML = '';
    state.axes.forEach(axis => { const label = document.createElement('label'); label.className = 'variation-control'; label.innerHTML = `${axis.tag.toUpperCase()} <output>${axis.value}</output><input type="range" min="${axis.min}" max="${axis.max}" step="0.1" value="${axis.value}" data-axis="${axis.tag}" />`; holder.append(label); });
    holder.querySelectorAll('input').forEach(control => control.addEventListener('input', () => { control.parentElement.querySelector('output').textContent = control.value; const settings = [...holder.querySelectorAll('input')].map(item => `'${item.dataset.axis}' ${item.value}`).join(', '); document.documentElement.style.setProperty('--checker-variation', settings); }));
  }

  function updatePreview() {
    const text = $('#test-text').value;
    const preview = $('#test-preview');
    preview.textContent = text || ' '; preview.style.fontSize = `${$('#test-size').value}px`;
    preview.style.letterSpacing = `${$('#spacing-range').value}px`;
    $('#test-size-output').textContent = `${$('#test-size').value}px`;
    $('#spacing-output').textContent = `${$('#spacing-range').value}px`;
    if (state.mode === 'bitmap') renderBitmapPreview();
  }
  function filterGlyphs() {
    if (!state.font && !state.bitmap) return;
    const type = $('#category-filter').value, query = $('#glyph-search').value.trim().toLowerCase();
    const list = state.glyphs.filter(g => {
      const char = String.fromCodePoint(g.unicode);
      const category = type === 'all' || (type === 'upper' && /[A-Z]/.test(char)) || (type === 'lower' && /[a-z]/.test(char)) || (type === 'number' && /[0-9]/.test(char)) || (type === 'symbol' && !/[A-Za-z0-9]/.test(char));
      return category && (!query || char.toLowerCase().includes(query) || unicode(g.unicode).toLowerCase().includes(query.replace(/^u\+?/, 'u+')));
    });
    if (state.mode === 'bitmap') renderBitmapGlyphs(list.map(glyph => state.bitmap.lookup.get(glyph.unicode))); else renderGlyphs(list);
  }
  function renderGlyphs(glyphs) {
    const size = $('#size-range').value;
    grid.innerHTML = glyphs.map(g => { const char = String.fromCodePoint(g.unicode); const safe = char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '&' ? '&amp;' : char; return `<article class="glyph-card" data-unicode="${g.unicode}" title="Inspect ${unicode(g.unicode)}"><span class="glyph-label">${safe}</span><span class="glyph-render" style="font-size:${size}px">${safe}</span><span class="glyph-code">${unicode(g.unicode)}</span></article>`; }).join('');
    $('#glyph-title').textContent = `${glyphs.length} glyph${glyphs.length === 1 ? '' : 's'} displayed`;
  }

  function renderBitmapGlyphs(glyphs) {
    const atlas = state.bitmap, source = atlas.displayImage || atlas.image, sourceUrl = atlas.displayUrl || atlas.url, size = Number($('#size-range').value), scale = (size * 3) / Math.max(...glyphs.map(glyph => glyph.height || 1), 1), cardHeight = Math.max(128, Math.round(size * 2));
    grid.innerHTML = glyphs.map(glyph => { const char = String.fromCodePoint(glyph.id); const safe = char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '&' ? '&amp;' : char; const width = Math.max(1, glyph.width * scale), height = Math.max(1, glyph.height * scale); return `<article class="glyph-card" style="height:${cardHeight}px" data-unicode="${glyph.id}"><span class="glyph-label">${safe}</span><span class="bitmap-render" style="width:${width}px;height:${height}px;background-image:url('${sourceUrl}');background-size:${source.width * scale}px ${source.height * scale}px;background-position:-${glyph.x * scale}px -${glyph.y * scale}px"></span><span class="glyph-code">${unicode(glyph.id)}</span></article>`; }).join('');
    $('#glyph-title').textContent = `${glyphs.length} bitmap glyph${glyphs.length === 1 ? '' : 's'} displayed`;
  }

  function renderBitmapPreview() {
    if (!state.bitmap) return;
    const canvas = $('#bitmap-test-canvas'), ctx = canvas.getContext('2d'), bitmap = state.bitmap, source = bitmap.displayImage || bitmap.image, text = $('#test-text').value || ' ', scale = Number($('#test-size').value) / bitmap.lineHeight, spacing = Number($('#spacing-range').value);
    const lines = text.split('\n'), maxWidth = Math.max(...lines.map(line => [...line].reduce((total, char) => total + ((bitmap.lookup.get(char.codePointAt(0))?.xadvance || bitmap.lineHeight) * scale) + spacing, 0)), 220);
    canvas.width = Math.min(Math.max(220, Math.ceil(maxWidth + 36)), 1600); canvas.height = Math.max(115, Math.ceil(lines.length * bitmap.lineHeight * scale + 36)); canvas.style.width = `${canvas.width}px`; ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, canvas.width, canvas.height);
    let y = 18; lines.forEach(line => { let x = 18; [...line].forEach(char => { const glyph = bitmap.lookup.get(char.codePointAt(0)); if (glyph) { ctx.drawImage(source, glyph.x, glyph.y, glyph.width, glyph.height, x + glyph.xoffset * scale, y + glyph.yoffset * scale, glyph.width * scale, glyph.height * scale); x += glyph.xadvance * scale + spacing; } else x += bitmap.lineHeight * scale * .5 + spacing; }); y += bitmap.lineHeight * scale; });
  }

  async function applyBitmapColor() {
    if (!state.bitmap) return;
    const bitmap = state.bitmap, source = bitmap.image;
    if ($('#original-color-input').checked) { bitmap.displayImage = source; bitmap.displayUrl = bitmap.url; filterGlyphs(); renderBitmapPreview(); return; }
    const color = $('#color-input').value, red = parseInt(color.slice(1, 3), 16), green = parseInt(color.slice(3, 5), 16), blue = parseInt(color.slice(5, 7), 16);
    const canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height; const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(source, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height), data = pixels.data;
    for (let index = 0; index < data.length; index += 4) { const brightness = (data[index] + data[index + 1] + data[index + 2]) / 3; if (data[index + 3] && brightness > 70) { data[index] = red; data[index + 1] = green; data[index + 2] = blue; } }
    context.putImageData(pixels, 0, 0); bitmap.displayUrl = canvas.toDataURL('image/png'); const image = new Image(); await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = bitmap.displayUrl; }); bitmap.displayImage = image; filterGlyphs(); renderBitmapPreview();
  }

  async function loadBitmap(file) {
    if (!/\.zip$/i.test(file.name)) throw new Error('Choose a ZIP file containing bitmap font metadata and an atlas image.');
    if (!window.JSZip) throw new Error('The ZIP reader is not ready. Check your internet connection and try again.');
    const zip = await window.JSZip.loadAsync(file), files = Object.values(zip.files).filter(item => !item.dir);
    const meta = files.find(item => /\.(fnt|json|xml)$/i.test(item.name)); if (!meta) throw new Error('No FNT, JSON, or XML metadata file was found in this ZIP.');
    const extension = meta.name.split('.').pop().toLowerCase(), parsed = bitmapMetadata(await meta.async('text'), extension);
    parsed.chars = parsed.chars.filter(glyph => Number.isInteger(glyph.id) && glyph.id >= 0 && glyph.id <= 0x10ffff && Number.isFinite(glyph.x) && Number.isFinite(glyph.y) && Number.isFinite(glyph.width) && Number.isFinite(glyph.height));
    const requested = parsed.pages[0]?.split('/').pop().toLowerCase(); const atlas = files.find(item => /\.(png|webp|jpg|jpeg)$/i.test(item.name) && (!requested || item.name.split('/').pop().toLowerCase() === requested)) || files.find(item => /\.(png|webp|jpg|jpeg)$/i.test(item.name));
    if (!atlas) throw new Error(`Metadata found (${meta.name}), but its atlas image is missing from the ZIP.`); if (!parsed.chars.length) throw new Error('The metadata does not contain any readable glyphs.');
    const url = URL.createObjectURL(await atlas.async('blob')); const image = new Image(); await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
    state.bitmap = { ...parsed, url, image, lookup: new Map(parsed.chars.map(glyph => [glyph.id, glyph])) }; state.glyphs = parsed.chars.map(glyph => ({ unicode: glyph.id }));
    $('#family-name').textContent = parsed.name; $('#subfamily-name').textContent = 'Bitmap Font'; $('#font-format').textContent = extension.toUpperCase(); $('#font-size').textContent = formatSize(file.size); $('#glyph-count').textContent = parsed.chars.length; $('#units-per-em').textContent = `${parsed.lineHeight}px line height`; $('.empty-info').hidden = true; $('.metadata').hidden = false; $('#tester-font-label').textContent = `${parsed.name.toUpperCase()} / BITMAP`; $('#empty-state').hidden = true; $('#dialog-title').textContent = parsed.name; $('#full-metadata').innerHTML = [['Family', parsed.name], ['Format', extension.toUpperCase()], ['Metadata file', meta.name], ['Atlas file', atlas.name], ['Atlas size', `${image.width} x ${image.height}px`], ['Line height', `${parsed.lineHeight}px`], ['Glyphs mapped', parsed.chars.length]].map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join('');
    $('#health-button').disabled = false; await applyBitmapColor(); runHealthCheck();
  }

  function glyphDetails(unicodeValue) {
    const glyph = state.glyphs.find(item => item.unicode === unicodeValue);
    if (!glyph) return;
    const character = String.fromCodePoint(glyph.unicode);
    $('#glyph-dialog-title').textContent = `${character} / ${unicode(glyph.unicode)}`;
    $('#glyph-dialog-preview').textContent = character;
    const values = [['Character', character], ['Unicode', unicode(glyph.unicode)], ['Glyph index', glyph.index], ['Advance width', glyph.advanceWidth ?? 'Not available'], ['Left side bearing', glyph.leftSideBearing ?? 'Not available'], ['Path commands', glyph.path?.commands?.length ?? 'Not available']];
    $('#glyph-details').innerHTML = values.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join('');
    $('#glyph-dialog').showModal();
  }

  function runHealthCheck() {
    if (state.mode === 'bitmap' && state.bitmap) {
      const bitmap = state.bitmap, checks = [{ label: 'Glyph mapping', detail: `${bitmap.chars.length} mapped glyphs`, kind: 'good' }, { label: 'Atlas image', detail: `${bitmap.image.width} x ${bitmap.image.height}px`, kind: 'good' }, { label: 'Line height', detail: `${bitmap.lineHeight}px`, kind: bitmap.lineHeight > 0 ? 'good' : 'warn' }];
      $('#health-results').innerHTML = checks.map(check => `<div class="health-result ${check.kind}"><i></i><strong>${check.label}</strong><span>${check.detail}</span></div>`).join(''); $('#health-results').hidden = false; $('#health-summary').textContent = 'LOOKS GOOD'; $('#health-summary').className = 'health-summary good'; return;
    }
    if (!state.font) return;
    const codepoints = new Set(state.glyphs.map(glyph => glyph.unicode));
    const ascii = Array.from({ length: 95 }, (_, index) => index + 32);
    const asciiFound = ascii.filter(point => codepoints.has(point)).length;
    const names = state.font.names || {};
    const tables = state.font.tables || {};
    const checks = [
      { label: 'Unicode mapping', detail: `${state.glyphs.length} mapped glyphs`, kind: state.glyphs.length ? 'good' : 'warn' },
      { label: 'Basic Latin coverage', detail: `${asciiFound} / ${ascii.length} characters`, kind: asciiFound === ascii.length ? 'good' : 'warn' },
      { label: 'Font naming', detail: fontName(names, 'fontFamily') && fontName(names, 'fullName') ? 'Family and full name found' : 'Some name fields are missing', kind: fontName(names, 'fontFamily') && fontName(names, 'fullName') ? 'good' : 'warn' },
      { label: 'Layout tables', detail: `${tables.gsub ? 'GSUB' : ''}${tables.gsub && tables.gpos ? ' + ' : ''}${tables.gpos ? 'GPOS' : ''}${!tables.gsub && !tables.gpos ? 'No GSUB / GPOS found' : ''}`, kind: tables.gsub || tables.gpos ? 'good' : 'warn' },
      { label: 'Vertical metrics', detail: state.font.ascender > 0 && state.font.descender < 0 ? `${state.font.ascender} / ${state.font.descender}` : 'Check ascender and descender values', kind: state.font.ascender > 0 && state.font.descender < 0 ? 'good' : 'warn' }
    ];
    $('#health-results').innerHTML = checks.map(check => `<div class="health-result ${check.kind}"><i></i><strong>${check.label}</strong><span>${check.detail}</span></div>`).join('');
    $('#health-results').hidden = false;
    const warnings = checks.filter(check => check.kind === 'warn').length;
    const summary = $('#health-summary'); summary.textContent = warnings ? `${warnings} NOTICE${warnings > 1 ? 'S' : ''}` : 'LOOKS GOOD'; summary.className = `health-summary ${warnings ? 'warn' : 'good'}`;
  }
  function setBackground(value) {
    const isColor = value === 'color'; $('#background-color-options').hidden = !isColor;
    for (const element of [$('#glyph-canvas'), $('#test-preview'), $('#bitmap-test-canvas')]) { element.classList.remove('dark', 'light', 'grid'); if (!isColor) element.classList.add(value); element.style.backgroundColor = isColor ? $('#background-color-input').value : ''; }
  }
  function showMetadata(font, file) {
    const names = font.names;
    const family = fontName(names, 'fontFamily') || file.name.replace(/\.[^.]+$/, '');
    const subfamily = fontName(names, 'fontSubfamily') || 'Regular';
    $('#family-name').textContent = family; $('#subfamily-name').textContent = subfamily;
    $('#font-format').textContent = file.name.split('.').pop().toUpperCase(); $('#font-size').textContent = formatSize(file.size);
    $('#glyph-count').textContent = state.glyphs.length; $('#units-per-em').textContent = font.unitsPerEm || '—';
    $('.empty-info').hidden = true; $('.metadata').hidden = false; $('.status-dot').style.background = '#5ec78b';
    $('#tester-font-label').textContent = `${family.toUpperCase()} / ${subfamily.toUpperCase()}`;
    const tableData = [['Family', family], ['Subfamily', subfamily], ['Full name', fontName(names, 'fullName')], ['PostScript name', fontName(names, 'postScriptName')], ['Version', fontName(names, 'version')], ['Designer', fontName(names, 'designer')], ['Manufacturer', fontName(names, 'manufacturer')], ['Copyright', fontName(names, 'copyright')], ['License', fontName(names, 'license')], ['Units per em', font.unitsPerEm], ['Ascender', font.ascender], ['Descender', font.descender], ['Glyphs mapped', state.glyphs.length], ['Variable axes', state.axes.length ? state.axes.map(axis => axis.tag).join(', ') : 'None detected'], ['File', file.name]];
    $('#full-metadata').innerHTML = tableData.map(([key, value]) => `<dt>${key}</dt><dd>${clean(value)}</dd>`).join('');
    $('#dialog-title').textContent = family;
  }
  async function loadFont(file) {
    const extension = file.name.split('.').pop().toLowerCase();
    if (!['ttf','otf','woff','woff2'].includes(extension)) throw new Error('Unsupported format. Choose a TTF, OTF, WOFF, or WOFF2 file.');
    if (!window.opentype) throw new Error('The font parser is not ready. Check your internet connection and try again.');
    const buffer = await file.arrayBuffer();
    const sourceBuffer = extension === 'woff2' ? await decompressWoff2(buffer) : buffer;
    let font;
    try { font = window.opentype.parse(sourceBuffer); } catch { throw new Error('This font could not be read. The file may be corrupted or use an unsupported font table.'); }
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(file);
    const family = `CheckerFont${Date.now()}`;
    await new FontFace(family, `url(${state.objectUrl})`).load().then(face => document.fonts.add(face));
    document.documentElement.style.setProperty('--checker-font', family);
    document.documentElement.style.setProperty('--checker-variation', 'normal');
    document.querySelectorAll('.glyph-render, #test-preview').forEach(el => el.style.fontFamily = family);
    state.font = font; state.axes = readVariableAxes(sourceBuffer); setupVariations();
    const seen = new Set(); state.glyphs = font.glyphs.glyphs ? Object.values(font.glyphs.glyphs).filter(g => Number.isInteger(g.unicode) && !seen.has(g.unicode) && seen.add(g.unicode)) : [];
    $('#empty-state').hidden = true; showMetadata(font, file); filterGlyphs();
    $('#health-button').disabled = false; runHealthCheck();
  }
  async function receive(file) { const extension = file.name.split('.').pop().toLowerCase(), detectedMode = extension === 'zip' ? 'bitmap' : ['ttf', 'otf', 'woff', 'woff2'].includes(extension) ? 'vector' : null; dropzone.classList.add('is-loading'); try { if (!detectedMode) throw new Error('Choose a vector font file or a bitmap font ZIP.'); if (detectedMode !== state.mode) setMode(detectedMode); if (detectedMode === 'bitmap') await loadBitmap(file); else await loadFont(file); showNotice(`${file.name} is ready to inspect.`, 'success'); } catch (error) { showNotice(error.message, 'error'); } finally { dropzone.classList.remove('is-loading'); input.value = ''; } }
  input.addEventListener('change', () => input.files[0] && receive(input.files[0]));
  ['dragenter','dragover'].forEach(e => dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(e => dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', e => e.dataTransfer.files[0] && receive(e.dataTransfer.files[0]));
  $('#size-range').addEventListener('input', e => { $('#size-output').textContent = `${e.target.value}px`; filterGlyphs(); });
  $('#color-input').addEventListener('input', e => { document.documentElement.style.setProperty('--glyph-color', e.target.value); if (state.mode === 'bitmap') applyBitmapColor(); });
  document.querySelectorAll('[data-text-color]').forEach(button => button.addEventListener('click', () => { $('#color-input').value = button.dataset.textColor; document.documentElement.style.setProperty('--glyph-color', button.dataset.textColor); if (state.mode === 'bitmap') applyBitmapColor(); }));
  $('#original-color-input').addEventListener('change', () => { if (state.mode === 'bitmap') applyBitmapColor(); });
  $('#background-select').addEventListener('change', e => setBackground(e.target.value));
  $('#background-color-input').addEventListener('input', () => { if ($('#background-select').value === 'color') setBackground('color'); });
  document.querySelectorAll('[data-background-color]').forEach(button => button.addEventListener('click', () => { $('#background-color-input').value = button.dataset.backgroundColor; setBackground('color'); }));
  $('#category-filter').addEventListener('change', filterGlyphs); $('#glyph-search').addEventListener('input', filterGlyphs);
  grid.addEventListener('click', event => { const card = event.target.closest('.glyph-card'); if (card && state.mode === 'vector') glyphDetails(Number(card.dataset.unicode)); });
  $('#test-text').addEventListener('input', updatePreview); $('#test-size').addEventListener('input', updatePreview); $('#spacing-range').addEventListener('input', updatePreview);
  document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => { const presets = { pangram: 'The quick brown fox jumps over the lazy dog.\nSphinx of black quartz, judge my vow.', numbers: '0123456789\n1234567890', symbols: '! @ # $ % ^ & * ( )\n[ ] { } < > + - = / ?' }; $('#test-text').value = button.dataset.preset === 'clear' ? '' : presets[button.dataset.preset]; updatePreview(); }));
  $('#metadata-button').addEventListener('click', () => $('#metadata-dialog').showModal()); $('#close-dialog').addEventListener('click', () => $('#metadata-dialog').close());
  $('#health-button').addEventListener('click', () => { runHealthCheck(); showNotice('Font check refreshed.', 'success'); }); $('#close-glyph-dialog').addEventListener('click', () => $('#glyph-dialog').close());
  $('#vector-mode').addEventListener('click', () => setMode('vector')); $('#bitmap-mode').addEventListener('click', () => setMode('bitmap'));
  setMode('vector');
})();
