/* app.js — 画面の描画と操作 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const state = {
    fileName: '',
    sheets: [],
    sheetIndex: 0,
    headerRow: 0,
    table: null,
    rules: [],
    items: [],
    labelColumns: [],
    standardize: false,
    gradeMode: 'relative',
    gradeLabel: 'number',
    shares: [7, 24, 38, 24, 7],
    thresholds: [60, 55, 45, 40],
    filtered: null,
    result: null,
  };

  /* ---------------------------------------------------------- ユーティリティ */

  function fmt(n, digits) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return Number(n).toFixed(digits === undefined ? 1 : digits);
  }

  function cellText(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v);
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
      }
    }
    for (const c of children || []) if (c) node.appendChild(c);
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  const ID_LIKE = /番号|ＮＯ|no\.?$|^no$|id|学籍|社員|コード|code|年齢|生年|年度|電話/i;

  /* ------------------------------------------------------------ 読み込み */

  async function loadFile(file) {
    const err = $('load-error');
    err.classList.add('hidden');
    try {
      const sheets = await window.TableReader.readFile(file);
      state.fileName = file.name || '';
      state.sheets = sheets;
      state.sheetIndex = sheets.findIndex((s) => s.rows.some((r) => r && r.length)) || 0;
      if (state.sheetIndex < 0) state.sheetIndex = 0;

      const sel = $('sheet');
      clear(sel);
      sheets.forEach((s, i) => sel.appendChild(el('option', { value: i, text: s.name })));
      sel.value = state.sheetIndex;

      state.headerRow = window.Rating.guessHeaderRow(sheets[state.sheetIndex].rows);
      $('header-row').value = state.headerRow + 1;

      $('load-options').classList.remove('hidden');
      rebuildTable(true);
    } catch (e) {
      err.textContent = e && e.message ? e.message : String(e);
      err.classList.remove('hidden');
      $('load-options').classList.add('hidden');
      ['step-filter', 'step-config', 'step-result'].forEach((s) => $(s).classList.add('hidden'));
    }
  }

  function rebuildTable(resetSettings) {
    const rows = state.sheets[state.sheetIndex].rows;
    state.table = window.Rating.buildTable(rows, state.headerRow);

    $('load-summary').textContent =
      state.table.records.length + ' 行 × ' + state.table.headers.length + ' 列を読み込みました';

    if (resetSettings) {
      const suggested = window.Rating.suggestFilter(state.table);
      state.rules = suggested ? [suggested] : [{ columnIndex: -1, values: [], keyword: '' }];
      state.items = state.table.columns
        .filter((c) => c.isNumeric && c.uniqueCount > 1 && !ID_LIKE.test(c.name))
        .map((c) => ({ columnIndex: c.index, weight: 1 }));
      state.labelColumns = state.table.columns
        .filter((c) => !c.isNumeric && c.filled > 0)
        .slice(0, 2)
        .map((c) => c.index);
      if (!state.labelColumns.length && state.table.columns.length) {
        state.labelColumns = [state.table.columns[0].index];
      }
    } else {
      const max = state.table.headers.length - 1;
      state.rules = state.rules.filter((r) => r.columnIndex <= max);
      state.items = state.items.filter((i) => i.columnIndex <= max);
      state.labelColumns = state.labelColumns.filter((i) => i <= max);
    }

    renderPreview();
    renderRules();
    renderItems();
    renderLabels();
    $('step-filter').classList.remove('hidden');
    $('step-config').classList.remove('hidden');
    recompute();
  }

  function renderPreview() {
    const table = $('preview');
    clear(table);
    const head = el('tr', null, [el('th', { class: 'dim', text: '行' })]);
    state.table.headers.forEach((h, i) => {
      const col = state.table.columns[i];
      head.appendChild(el('th', { class: col.isNumeric ? 'num' : '', text: h }));
    });
    table.appendChild(el('thead', null, [head]));

    const body = el('tbody');
    state.table.records.slice(0, 8).forEach((rec) => {
      const tr = el('tr', null, [el('td', { class: 'dim', text: String(rec.sourceRow) })]);
      rec.values.forEach((v, i) => {
        tr.appendChild(el('td', {
          class: state.table.columns[i] && state.table.columns[i].isNumeric ? 'num' : '',
          text: cellText(v),
        }));
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
  }

  /* -------------------------------------------------------------- 除外設定 */

  function columnOptions(selected, placeholder) {
    const sel = el('select');
    sel.appendChild(el('option', { value: '-1', text: placeholder }));
    state.table.columns.forEach((c) => {
      const opt = el('option', { value: String(c.index), text: c.letter + ': ' + c.name });
      sel.appendChild(opt);
    });
    sel.value = String(selected);
    return sel;
  }

  function renderRules() {
    const host = $('rules');
    clear(host);

    state.rules.forEach((rule, ri) => {
      const select = columnOptions(rule.columnIndex, '— 列を選ぶ —');
      select.addEventListener('change', () => {
        rule.columnIndex = Number(select.value);
        rule.values = [];
        renderRules();
        recompute();
      });

      const keyword = el('input', { type: 'text', placeholder: '例: 外国', value: rule.keyword || '' });
      keyword.addEventListener('input', () => {
        rule.keyword = keyword.value;
        recompute();
      });

      const remove = el('button', {
        type: 'button', class: 'btn-icon', title: 'この条件を削除', text: '✕',
        onclick: () => {
          state.rules.splice(ri, 1);
          if (!state.rules.length) state.rules.push({ columnIndex: -1, values: [], keyword: '' });
          renderRules();
          recompute();
        },
      });

      const head = el('div', { class: 'rule-head' }, [
        el('label', { class: 'field' }, [el('span', { text: '対象の列' }), select]),
        el('label', { class: 'field' }, [el('span', { text: '部分一致で除外（任意）' }), keyword]),
        remove,
      ]);

      const box = el('div', { class: 'rule' }, [head]);

      if (rule.columnIndex >= 0) {
        const counts = window.Rating.valueCounts(state.table, rule.columnIndex);
        const list = el('div', { class: 'rule-values' });
        if (counts.length > 300) {
          list.appendChild(el('span', {
            class: 'field-note',
            text: '値の種類が多すぎます (' + counts.length + ' 種)。部分一致の欄で指定してください。',
          }));
        } else {
          counts.forEach((entry) => {
            const cb = el('input', { type: 'checkbox' });
            cb.checked = rule.values.includes(entry.value);
            cb.addEventListener('change', () => {
              if (cb.checked) {
                if (!rule.values.includes(entry.value)) rule.values.push(entry.value);
              } else {
                rule.values = rule.values.filter((v) => v !== entry.value);
              }
              recompute();
            });
            list.appendChild(el('label', { class: 'check' }, [
              cb,
              el('span', { text: entry.value }),
              el('span', { class: 'count', text: '(' + entry.count + ')' }),
            ]));
          });
        }
        box.appendChild(list);
      }
      host.appendChild(box);
    });
  }

  function renderRemoved(removed) {
    const details = $('removed-details');
    const table = $('removed-table');
    clear(table);
    if (!removed.length) {
      details.classList.add('hidden');
      return;
    }
    details.classList.remove('hidden');

    const head = el('tr', null, [el('th', { class: 'dim', text: '行' })]);
    state.table.headers.forEach((h) => head.appendChild(el('th', { text: h })));
    table.appendChild(el('thead', null, [head]));

    const body = el('tbody');
    removed.slice(0, 200).forEach(({ record }) => {
      const tr = el('tr', { class: 'excluded' }, [el('td', { class: 'dim', text: String(record.sourceRow) })]);
      record.values.forEach((v) => tr.appendChild(el('td', { text: cellText(v) })));
      body.appendChild(tr);
    });
    table.appendChild(body);
    if (removed.length > 200) {
      table.appendChild(el('tfoot', null, [
        el('tr', null, [el('td', { class: 'dim', colspan: String(state.table.headers.length + 1),
          text: '他 ' + (removed.length - 200) + ' 行' })]),
      ]));
    }
  }

  /* -------------------------------------------------------------- 評価設定 */

  function renderItems() {
    const host = $('items');
    clear(host);
    const numeric = state.table.columns.filter((c) => c.isNumeric && c.filled > 0);
    if (!numeric.length) {
      host.appendChild(el('span', { class: 'field-note', text: '数値の列が見つかりませんでした。見出しの行を見直してください。' }));
      return;
    }
    numeric.forEach((col) => {
      const item = state.items.find((i) => i.columnIndex === col.index);
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!item;

      const weight = el('input', { type: 'number', step: '0.1', min: '0', value: item ? String(item.weight) : '1' });
      weight.disabled = !item;
      weight.addEventListener('input', () => {
        const target = state.items.find((i) => i.columnIndex === col.index);
        if (target) target.weight = Number(weight.value);
        recompute();
      });

      cb.addEventListener('change', () => {
        if (cb.checked) state.items.push({ columnIndex: col.index, weight: Number(weight.value) || 1 });
        else state.items = state.items.filter((i) => i.columnIndex !== col.index);
        weight.disabled = !cb.checked;
        recompute();
      });

      host.appendChild(el('label', { class: 'item-chip' }, [
        cb,
        el('span', { text: col.name }),
        el('span', { class: 'count', text: '×' }),
        weight,
      ]));
    });
  }

  function renderLabels() {
    const host = $('labels');
    clear(host);
    state.table.columns.forEach((col) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = state.labelColumns.includes(col.index);
      cb.addEventListener('change', () => {
        if (cb.checked) state.labelColumns.push(col.index);
        else state.labelColumns = state.labelColumns.filter((i) => i !== col.index);
        state.labelColumns.sort((a, b) => a - b);
        recompute();
      });
      host.appendChild(el('label', { class: 'check' }, [cb, el('span', { text: col.name })]));
    });
  }

  /* ------------------------------------------------------------ 集計と表示 */

  function recompute() {
    if (!state.table) return;

    const filtered = window.Rating.applyFilters(state.table, state.rules);
    state.filtered = filtered;

    const total = state.table.records.length;
    const counts = $('filter-counts');
    clear(counts);
    counts.appendChild(el('span', { class: 'kept' }, [
      el('span', { text: '評価の対象 ' }), el('b', { text: String(filtered.kept.length) }), el('span', { text: ' 行' }),
    ]));
    counts.appendChild(el('span', { class: 'removed' }, [
      el('span', { text: '除外 ' }), el('b', { text: String(filtered.removed.length) }), el('span', { text: ' 行' }),
    ]));
    counts.appendChild(el('span', { class: 'field-note', text: '読み込んだ全 ' + total + ' 行' }));
    renderRemoved(filtered.removed);

    state.result = window.Rating.evaluate(filtered.kept, {
      items: state.items,
      standardize: state.standardize,
      gradeMode: state.gradeMode,
      gradeLabel: state.gradeLabel,
      shares: state.shares,
      thresholds: state.thresholds,
    });

    renderResult();
  }

  function resultColumns() {
    const cols = [{ key: 'rank', label: '順位', num: true }];
    state.labelColumns.forEach((ci) => {
      cols.push({ key: 'col' + ci, label: state.table.headers[ci], columnIndex: ci, num: false });
    });
    state.result.items.forEach((it, i) => {
      cols.push({ key: 'item' + i, label: state.table.headers[it.columnIndex], itemIndex: i, num: true });
    });
    cols.push({ key: 'total', label: state.standardize ? '総合点 (偏差値換算)' : '総合点', num: true });
    cols.push({ key: 'tscore', label: '偏差値', num: true });
    cols.push({ key: 'grade', label: '評価', num: false });
    return cols;
  }

  function resultValue(row, col) {
    switch (col.key) {
      case 'rank': return String(row.rank);
      case 'total': return fmt(row.total, 1);
      case 'tscore': return fmt(row.tScore, 1);
      case 'grade': return row.grade;
      default:
        if (col.columnIndex !== undefined) return cellText(row.record.values[col.columnIndex]);
        if (col.itemIndex !== undefined) {
          const v = row.scores[col.itemIndex];
          return v === null ? '' : cellText(v);
        }
        return '';
    }
  }

  function renderResult() {
    const section = $('step-result');
    const note = $('config-note');
    const result = state.result;
    if (!result || !result.rows.length) {
      section.classList.add('hidden');
      note.textContent = !state.items.length
        ? '評価に使う項目を 1 つ以上選ぶと、ここから下に結果が出ます。'
        : '評価できる行がありません。除外条件や見出しの行を見直してください。';
      return;
    }
    note.textContent = '';
    section.classList.remove('hidden');

    const s = result.stats;
    const summary = $('result-summary');
    clear(summary);
    const grid = el('div', { class: 'summary-grid' });
    const stats = [
      ['対象人数', String(s.count) + ' 人'],
      ['平均', fmt(s.mean, 1)],
      ['標準偏差', fmt(s.sd, 2)],
      ['最高', fmt(s.max, 1)],
      ['最低', fmt(s.min, 1)],
    ];
    stats.forEach(([label, value]) => {
      grid.appendChild(el('div', { class: 'stat' }, [
        el('div', { class: 'label', text: label }),
        el('div', { class: 'value', text: value }),
      ]));
    });
    summary.appendChild(grid);
    summary.appendChild(el('p', {
      class: 'field-note',
      text: '除外した ' + state.filtered.removed.length + ' 行は平均・標準偏差・順位のいずれにも含めていません。',
    }));

    const dist = $('result-dist');
    clear(dist);
    const maxCount = Math.max(...s.distribution.map((d) => d.count), 1);
    s.distribution.forEach((d) => {
      const bar = el('div', { class: 'dist-bar' }, [
        el('span', { style: 'width:' + (d.count / maxCount * 100) + '%' }),
      ]);
      dist.appendChild(el('div', { class: 'dist-row' }, [
        el('span', { class: 'grade-cell', text: d.label }),
        bar,
        el('span', { class: 'field-note', text: d.count + ' 人 (' + fmt(s.count ? d.count / s.count * 100 : 0, 1) + '%)' }),
      ]));
    });

    const cols = resultColumns();
    const table = $('result-table');
    clear(table);
    const head = el('tr');
    cols.forEach((c) => head.appendChild(el('th', { class: c.num ? 'num' : '', text: c.label })));
    table.appendChild(el('thead', null, [head]));

    const body = el('tbody');
    result.rows.forEach((row) => {
      const tr = el('tr');
      cols.forEach((c) => {
        const cls = (c.num ? 'num' : '') + (c.key === 'grade' ? ' grade-cell' : '');
        tr.appendChild(el('td', { class: cls.trim(), text: resultValue(row, c) }));
      });
      body.appendChild(tr);
    });
    table.appendChild(body);

    const skipNote = $('skipped-note');
    skipNote.textContent = result.skipped.length
      ? '評価項目がすべて空欄だった ' + result.skipped.length + ' 行は結果表から除いています。'
      : '';
  }

  /* -------------------------------------------------------------- 書き出し */

  function resultMatrix() {
    const cols = resultColumns();
    const rows = [cols.map((c) => c.label)];
    state.result.rows.forEach((row) => rows.push(cols.map((c) => resultValue(row, c))));
    return rows;
  }

  function toCsv(rows) {
    return rows.map((r) => r.map((v) => {
      const s = String(v === null || v === undefined ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
  }

  function exportCsv() {
    if (!state.result || !state.result.rows.length) return;
    // Excel で開いたときに文字化けしないよう BOM を付ける
    const blob = new Blob(['﻿' + toCsv(resultMatrix())], { type: 'text/csv;charset=utf-8' });
    const base = (state.fileName || '評価').replace(/\.[^.]+$/, '');
    const a = el('a', { href: URL.createObjectURL(blob), download: base + '_評価.csv' });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  async function copyTsv() {
    if (!state.result || !state.result.rows.length) return;
    const text = resultMatrix().map((r) => r.join('\t')).join('\n');
    const note = $('action-note');
    try {
      await navigator.clipboard.writeText(text);
      note.textContent = 'コピーしました。Excel に貼り付けられます。';
    } catch (e) {
      note.textContent = 'コピーできませんでした。CSV 保存をお使いください。';
    }
    setTimeout(() => { note.textContent = ''; }, 4000);
  }

  /* ---------------------------------------------------------------- 初期化 */

  function bind() {
    const drop = $('drop');
    const file = $('file');

    file.addEventListener('change', () => {
      if (file.files && file.files[0]) loadFile(file.files[0]);
    });

    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove('over');
    }));
    drop.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    $('sheet').addEventListener('change', (e) => {
      state.sheetIndex = Number(e.target.value);
      state.headerRow = window.Rating.guessHeaderRow(state.sheets[state.sheetIndex].rows);
      $('header-row').value = state.headerRow + 1;
      rebuildTable(true);
    });

    $('header-row').addEventListener('change', (e) => {
      const v = Math.max(1, Number(e.target.value) || 1);
      e.target.value = v;
      state.headerRow = v - 1;
      rebuildTable(false);
    });

    $('add-rule').addEventListener('click', () => {
      state.rules.push({ columnIndex: -1, values: [], keyword: '' });
      renderRules();
    });

    $('standardize').addEventListener('change', (e) => {
      state.standardize = e.target.checked;
      recompute();
    });

    $('grade-mode').addEventListener('change', (e) => {
      state.gradeMode = e.target.value;
      $('shares-row').classList.toggle('hidden', state.gradeMode !== 'relative');
      $('thresholds-row').classList.toggle('hidden', state.gradeMode !== 'absolute');
      recompute();
    });

    $('grade-label').addEventListener('change', (e) => {
      state.gradeLabel = e.target.value;
      recompute();
    });

    [0, 1, 2, 3, 4].forEach((i) => {
      $('share-' + i).addEventListener('input', () => {
        state.shares = [0, 1, 2, 3, 4].map((k) => Number($('share-' + k).value) || 0);
        $('shares-sum').textContent = '合計 ' + state.shares.reduce((a, b) => a + b, 0) + '%';
        recompute();
      });
    });
    $('shares-sum').textContent = '合計 100%';

    [0, 1, 2, 3].forEach((i) => {
      $('th-' + i).addEventListener('input', () => {
        state.thresholds = [0, 1, 2, 3].map((k) => Number($('th-' + k).value) || 0);
        recompute();
      });
    });

    $('export-csv').addEventListener('click', exportCsv);
    $('copy-tsv').addEventListener('click', copyTsv);
    $('print').addEventListener('click', () => window.print());
  }

  bind();
})();
