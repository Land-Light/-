/* xlsx.js — 外部ライブラリなしで .xlsx / .csv / .tsv を読み込む
 *
 * .xlsx は ZIP なので、まず ZIP のセントラルディレクトリを読み、
 * ブラウザ標準の DecompressionStream('deflate-raw') で展開してから
 * DOMParser で XML を解析する。
 */
(function (global) {
  'use strict';

  const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  /* ------------------------------------------------------------------ ZIP */

  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error(
        'このブラウザは .xlsx の展開に対応していません (DecompressionStream 未対応)。' +
        'Excel で「CSV UTF-8」として保存し直してから読み込んでください。');
    }
    const stream = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** ZIP を読み、「エントリ名 → 展開関数」の Map を返す */
  function openZip(buffer) {
    const dv = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // EOCD (End Of Central Directory) を末尾から探す
    let eocd = -1;
    const limit = Math.max(0, bytes.length - 66000);
    for (let i = bytes.length - 22; i >= limit; i--) {
      if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP として読めませんでした。.xlsx ファイルか確認してください。');

    let ptr = u32(dv, eocd + 16);
    const entries = new Map();
    const utf8 = new TextDecoder('utf-8');

    while (ptr + 46 <= bytes.length && u32(dv, ptr) === 0x02014b50) {
      const method = u16(dv, ptr + 10);
      const compSize = u32(dv, ptr + 20);
      const nameLen = u16(dv, ptr + 28);
      const extraLen = u16(dv, ptr + 30);
      const cmtLen = u16(dv, ptr + 32);
      const localOff = u32(dv, ptr + 42);
      const name = utf8.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
      entries.set(name, { method, compSize, localOff });
      ptr += 46 + nameLen + extraLen + cmtLen;
    }
    if (!entries.size) throw new Error('ZIP の中身が空でした。');

    async function read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.localOff === 0xffffffff) {
        throw new Error('ZIP64 形式の .xlsx には対応していません。CSV で保存し直してください。');
      }
      // ローカルヘッダを読み飛ばしてデータ本体の位置を求める
      if (u32(dv, e.localOff) !== 0x04034b50) throw new Error('ZIP の内部構造が壊れています。');
      const start = e.localOff + 30 + u16(dv, e.localOff + 26) + u16(dv, e.localOff + 28);
      const raw = bytes.subarray(start, start + e.compSize);
      if (e.method === 0) return raw;
      if (e.method === 8) return await inflateRaw(raw);
      throw new Error('未対応の圧縮方式です (method=' + e.method + ')。');
    }

    async function readText(name) {
      const data = await read(name);
      return data ? new TextDecoder('utf-8').decode(data) : null;
    }

    return { names: [...entries.keys()], read, readText };
  }

  /* ------------------------------------------------------------------ XML */

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('ファイル内の XML を解析できませんでした。');
    }
    return doc;
  }

  function tags(node, name) {
    return Array.from(node.getElementsByTagNameNS('*', name));
  }

  function attr(el, name, ns) {
    if (ns) {
      const v = el.getAttributeNS(ns, name);
      if (v != null) return v;
    }
    return el.getAttribute(name);
  }

  /** 共有文字列: <si> 直下のテキスト。日本語 Excel のふりがな (rPh) は除く */
  function siText(si) {
    let out = '';
    for (const child of si.children) {
      const tag = child.localName;
      if (tag === 'rPh') continue;
      if (tag === 't') out += child.textContent;
      else if (tag === 'r') {
        for (const rc of child.children) if (rc.localName === 't') out += rc.textContent;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------- 日付書式 */

  const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

  function looksLikeDateFormat(code) {
    if (!code) return false;
    // 「"..."」内やカラー指定を除いた上で日付/時刻用の文字が残るか見る
    const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
    return /[ymdhs]/i.test(stripped) && !/^[^ymdhs]*$/i.test(stripped);
  }

  function serialToDateText(serial) {
    const ms = Math.round((serial - 25569) * 86400000);
    const d = new Date(ms);
    if (isNaN(d.getTime())) return String(serial);
    const p = (n) => String(n).padStart(2, '0');
    const ymd = d.getUTCFullYear() + '/' + p(d.getUTCMonth() + 1) + '/' + p(d.getUTCDate());
    const frac = Math.abs(serial % 1);
    if (frac < 1e-6) return ymd;
    return ymd + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }

  async function readDateStyles(zip) {
    const text = await zip.readText('xl/styles.xml');
    if (!text) return new Set();
    const doc = parseXml(text);
    const custom = new Map();
    for (const nf of tags(doc, 'numFmt')) {
      custom.set(Number(nf.getAttribute('numFmtId')), nf.getAttribute('formatCode') || '');
    }
    const dateStyles = new Set();
    const cellXfs = tags(doc, 'cellXfs')[0];
    if (!cellXfs) return dateStyles;
    let index = 0;
    for (const xf of cellXfs.children) {
      if (xf.localName !== 'xf') continue;
      const id = Number(xf.getAttribute('numFmtId') || 0);
      if (BUILTIN_DATE_FMT.has(id) || looksLikeDateFormat(custom.get(id))) dateStyles.add(index);
      index++;
    }
    return dateStyles;
  }

  /* ------------------------------------------------------------- シート */

  function colIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  function parseSheet(xml, shared, dateStyles) {
    const doc = parseXml(xml);
    const rows = [];
    for (const rowEl of tags(doc, 'row')) {
      const rowNum = Number(rowEl.getAttribute('r'));
      const cells = [];
      let auto = 0;
      for (const c of rowEl.children) {
        if (c.localName !== 'c') continue;
        const ref = c.getAttribute('r');
        const idx = ref ? colIndex(ref) : auto;
        auto = idx + 1;
        const type = c.getAttribute('t');
        let value = null;
        if (type === 'inlineStr') {
          const is = tags(c, 'is')[0];
          value = is ? siText(is) : '';
        } else {
          const v = Array.from(c.children).find((x) => x.localName === 'v');
          const raw = v ? v.textContent : null;
          if (raw == null || raw === '') value = null;
          else if (type === 's') value = shared[Number(raw)] ?? '';
          else if (type === 'str' || type === 'e') value = raw;
          else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
          else {
            const num = Number(raw);
            const style = Number(c.getAttribute('s') || -1);
            value = dateStyles.has(style) && isFinite(num) ? serialToDateText(num)
              : (isFinite(num) ? num : raw);
          }
        }
        if (typeof value === 'string') value = value.trim();
        cells[idx] = value === '' ? null : value;
      }
      const target = isFinite(rowNum) && rowNum > 0 ? rowNum - 1 : rows.length;
      rows[target] = cells;
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return rows;
  }

  async function readXlsx(buffer) {
    const zip = openZip(buffer);

    let shared = [];
    const sharedXml = await zip.readText('xl/sharedStrings.xml');
    if (sharedXml) shared = tags(parseXml(sharedXml), 'si').map(siText);

    const dateStyles = await readDateStyles(zip);

    // rId → シートファイルの対応表
    const relMap = new Map();
    const relXml = await zip.readText('xl/_rels/workbook.xml.rels');
    if (relXml) {
      for (const r of tags(parseXml(relXml), 'Relationship')) {
        let target = r.getAttribute('Target') || '';
        target = target.replace(/^\/xl\//, '').replace(/^\.\//, '');
        relMap.set(r.getAttribute('Id'), target.startsWith('xl/') ? target : 'xl/' + target);
      }
    }

    const bookXml = await zip.readText('xl/workbook.xml');
    if (!bookXml) throw new Error('ブックの情報 (xl/workbook.xml) が見つかりませんでした。');

    const sheets = [];
    let fallback = 1;
    for (const s of tags(parseXml(bookXml), 'sheet')) {
      const name = s.getAttribute('name') || ('Sheet' + fallback);
      const rid = attr(s, 'id', REL_NS);
      const path = (rid && relMap.get(rid)) || ('xl/worksheets/sheet' + fallback + '.xml');
      fallback++;
      if (s.getAttribute('state') === 'veryHidden') continue;
      const xml = await zip.readText(path);
      if (!xml) continue;
      sheets.push({ name, rows: parseSheet(xml, shared, dateStyles) });
    }
    if (!sheets.length) throw new Error('シートが 1 つも読み込めませんでした。');
    return sheets;
  }

  /* ------------------------------------------------------------------ CSV */

  function decodeText(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      // Excel が書き出した Shift_JIS の CSV を救済する
      return new TextDecoder('shift_jis').decode(bytes);
    }
  }

  function guessDelimiter(text) {
    const head = text.slice(0, 5000);
    const counts = [',', '\t', ';'].map((d) => [d, head.split(d).length]);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] > 1 ? counts[0][0] : ',';
  }

  function parseCsv(text, delim) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += ch;
        continue;
      }
      if (ch === '"') { quoted = true; continue; }
      if (ch === delim) { row.push(field); field = ''; continue; }
      if (ch === '\r') continue;
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    return rows.map((cells) => cells.map((raw) => {
      const v = raw.trim();
      if (v === '') return null;
      // 「1,234」「85%」のような表記も数値として扱う
      const num = Number(v.replace(/,/g, ''));
      if (v !== '' && isFinite(num) && /^[-+]?[\d,]*\.?\d+$/.test(v)) return num;
      return v;
    }));
  }

  /* --------------------------------------------------------------- 入口 */

  async function readFile(file) {
    const buffer = await file.arrayBuffer();
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')) {
      const text = decodeText(buffer);
      const delim = name.endsWith('.tsv') ? '\t' : guessDelimiter(text);
      return [{ name: file.name || 'CSV', rows: parseCsv(text, delim) }];
    }
    if (name.endsWith('.xls')) {
      throw new Error('旧形式の .xls は読み込めません。Excel で .xlsx か CSV として保存し直してください。');
    }
    return await readXlsx(buffer);
  }

  global.TableReader = { readFile };
})(window);
