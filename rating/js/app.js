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
    dictLimit: 0,           // 0 = 姓の一覧を全件使う
    quickDropColumn: true,  // 判定に使った列を出力から外すか
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

  /** 名前の表記から除外候補を選び出す（列全体を分類してから候補にチェックを入れる） */
  function nameCandidates(columnIndex) {
    const counts = window.Rating.valueCounts(state.table, columnIndex);
    return window.NameHint.classifyColumn(counts);
  }

  /**
   * 最初に出す除外条件を決める。
   * 国籍などの列があればそれを使い、無ければ氏名の列から候補を拾う。
   */
  function defaultRule() {
    const byColumn = window.Rating.suggestFilter(state.table);
    if (byColumn) return { ...byColumn, mode: 'value' };

    const nameCol = window.NameHint.findNameColumn(state.table.columns);
    if (nameCol) {
      const cls = nameCandidates(nameCol.index);
      return {
        columnIndex: nameCol.index,
        mode: 'name',
        keyword: '',
        values: cls.results.filter((r) => window.NameHint.isCandidate(r.level)).map((r) => r.value),
      };
    }
    return { columnIndex: -1, mode: 'value', values: [], keyword: '' };
  }

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
      state.rules = [defaultRule()];
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

    renderRules();
    renderItems();
    renderLabels();
    $('step-filter').classList.remove('hidden');
    $('step-config').classList.remove('hidden');
    recompute();
  }

  /* ------------------------------------------------- 除外後の表（設定不要） */

  const QUICK_LIMIT = 300;

  /** 出力に載せる列（判定に使った列は既定で外す。氏名の列は残す） */
  function quickColumns() {
    const dropped = new Set();
    if (state.quickDropColumn) {
      state.filtered.activeRules.forEach((r) => {
        if (r.mode !== 'name') dropped.add(r.columnIndex);
      });
    }
    return state.table.columns.filter((c) => !dropped.has(c.index));
  }

  function quickMatrix() {
    const cols = quickColumns();
    const rows = [cols.map((c) => c.name)];
    state.filtered.kept.forEach((rec) => {
      rows.push(cols.map((c) => cellText(rec.values[c.index])));
    });
    return rows;
  }

  function renderQuick() {
    const section = $('step-quick');
    if (!state.table) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');

    const total = state.table.records.length;
    const kept = state.filtered.kept.length;
    const removed = state.filtered.removed.length;
    const rules = state.filtered.activeRules;

    // 何をもとに削除したかを 1 行で示す
    const summary = $('quick-summary');
    clear(summary);
    summary.appendChild(el('span', { class: 'quick-big', text: kept + ' 行' }));
    summary.appendChild(el('span', { text: 'を残しました（元は ' + total + ' 行、削除 ' + removed + ' 行）' }));

    const how = rules.map((r) => {
      const name = state.table.headers[r.columnIndex];
      if (r.mode === 'name') return '「' + name + '」の表記から判定';

      const kw = (r.keyword || '').trim();
      const remaining = window.Rating.valueCounts(state.table, r.columnIndex)
        .map((v) => v.value)
        .filter((v) => !r.values.includes(v));
      // 残した値がすべて「日本」なら、そう言ったほうが分かりやすい
      if (!kw && remaining.length && remaining.every(window.Rating.isJapanValue)) {
        const blank = r.values.includes('(空欄)') ? '（空欄の行も削除）' : '';
        return '「' + name + '」列が「' + remaining.join('・') + '」の行だけを残しました' + blank;
      }

      const parts = [];
      if (r.values && r.values.length) parts.push(r.values.slice(0, 6).join('・') + (r.values.length > 6 ? ' ほか' : ''));
      if (kw) parts.push('「' + kw + '」を含む');
      return '「' + name + '」列が ' + parts.join(' / ');
    });
    summary.appendChild(el('div', {
      class: 'field-note',
      text: how.length ? '判定: ' + how.join('、') : '削除の対象になる行は見つかりませんでした。',
    }));

    // 氏名から判定したときは、その限界を必ず出しておく
    const caution = $('quick-caution');
    const byName = rules.some((r) => r.mode === 'name');
    caution.classList.toggle('hidden', !byName);
    if (byName) {
      caution.textContent = '⚠ 氏名の表記からの推定です。国籍そのものは判定できません。'
        + '通名を使う外国籍の方は残り、日本国籍でも外国風の表記の方は削除されます。'
        + '下の表と「削除した行を確認する」を必ずご確認ください。';
    }

    const cols = quickColumns();
    const droppedCount = state.table.columns.length - cols.length;
    $('quick-note').textContent = droppedCount
      ? '判定に使った ' + droppedCount + ' 列を出力から外しています。'
      : (byName ? '氏名の列は、誰の行か分からなくなるため残しています。' : '');

    const table = $('quick-table');
    clear(table);
    const head = el('tr');
    cols.forEach((c) => head.appendChild(el('th', { class: c.isNumeric ? 'num' : '', text: c.name })));
    table.appendChild(el('thead', null, [head]));

    const body = el('tbody');
    state.filtered.kept.slice(0, QUICK_LIMIT).forEach((rec) => {
      const tr = el('tr');
      cols.forEach((c) => {
        tr.appendChild(el('td', {
          class: c.isNumeric ? 'num' : '',
          text: cellText(rec.values[c.index]),
        }));
      });
      body.appendChild(tr);
    });
    table.appendChild(body);

    $('quick-more').textContent = kept > QUICK_LIMIT
      ? '画面には先頭 ' + QUICK_LIMIT + ' 行だけ表示しています。保存・コピーは ' + kept + ' 行すべてが対象です。'
      : '';
  }

  function exportQuickCsv() {
    if (!state.filtered) return;
    const blob = new Blob(['﻿' + toCsv(quickMatrix())], { type: 'text/csv;charset=utf-8' });
    const base = (state.fileName || '表').replace(/\.[^.]+$/, '');
    downloadBlob(blob, base + '_除外後.csv');
  }

  async function copyQuick() {
    if (!state.filtered) return;
    await copyMatrix(quickMatrix(), $('quick-note'));
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

  /** 値のチェックボックス 1 個ぶん */
  function valueCheckbox(rule, value, count, badge) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = rule.values.includes(value);
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!rule.values.includes(value)) rule.values.push(value);
      } else {
        rule.values = rule.values.filter((v) => v !== value);
      }
      recompute();
    });
    return el('label', { class: 'check' }, [
      cb,
      el('span', { text: value }),
      el('span', { class: 'count', text: '(' + count + ')' }),
      badge ? el('span', { class: 'badge', text: badge }) : null,
    ]);
  }

  const DICT_PRESETS = [300, 1000, 3000, 5000, 10000, 20000, 0];

  /** 「上位何件までを日本の姓とみなすか」の切り替え */
  function dictControl(rule) {
    const total = window.Surnames.total;
    const sel = el('select');
    DICT_PRESETS.forEach((n) => {
      sel.appendChild(el('option', {
        value: String(n),
        text: n ? '上位 ' + n.toLocaleString() + ' 件' : '全 ' + total.toLocaleString() + ' 件',
      }));
    });
    sel.value = String(state.dictLimit);
    sel.addEventListener('change', () => {
      state.dictLimit = Number(sel.value);
      window.Surnames.setLimit(state.dictLimit || total);
      refreshCandidates(rule);   // 辞書が変わると仕分けも変わる
    });
    const dropCb = el('input', { type: 'checkbox' });
    dropCb.checked = window.Surnames.isDropCjk();
    dropCb.addEventListener('change', () => {
      window.Surnames.setDropCjk(dropCb.checked);
      refreshCandidates(rule);
    });

    return el('div', { class: 'dict-row' }, [
      el('label', { class: 'field' }, [el('span', { text: '日本の姓とみなす範囲' }), sel]),
      el('p', {
        class: 'field-note',
        text: state.dictLimit === 0
          ? '全 ' + total.toLocaleString() + ' 件を使っています。範囲を狭めるほど検出は増えますが、'
            + '珍しい姓の日本国籍の方も「一覧に無い」側へ入ります。'
          : '全 ' + total.toLocaleString() + ' 件のうち上位 ' + state.dictLimit.toLocaleString() + ' 件だけを日本の姓として扱っています。'
            + '狭めるほど検出は増えますが、珍しい姓の日本国籍の方も「一覧に無い」側へ入ります。',
      }),
      el('label', { class: 'check' }, [
        dropCb,
        el('span', { text: '中国・韓国系の主要な姓 ' + window.Surnames.cjkTotal + ' 件を日本の姓から外す' }),
      ]),
      el('p', {
        class: 'field-note',
        text: '李・金・張・陳などは日本にも実在する姓のため、外さないと漢字表記の氏名はほとんど検出されません。'
          + 'チェックを外せば全件まとめて元に戻ります。',
      }),
      cjkRestoreList(rule),
    ]);
  }

  /** 外している姓を 1 件ずつ日本の姓に戻すための一覧 */
  function cjkRestoreList(rule) {
    if (!window.Surnames.isDropCjk()) return null;
    const list = el('div', { class: 'rule-values' });
    window.Surnames.cjkList().forEach((entry) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !entry.restored;
      cb.addEventListener('change', () => {
        window.Surnames.restore(entry.name, !cb.checked);
        refreshCandidates(rule);
      });
      list.appendChild(el('label', { class: 'check' }, [
        cb,
        el('span', { text: entry.name }),
        el('span', { class: 'count', text: entry.rank ? '日本で ' + entry.rank.toLocaleString() + ' 位' : '一覧に無し' }),
      ]));
    });

    const restoredCount = window.Surnames.restoredCount();
    return el('details', { class: 'cjk-details' }, [
      el('summary', {
        text: '外している姓を個別に戻す'
          + (restoredCount ? '（' + restoredCount + ' 件を日本の姓に戻し中）' : ''),
      }),
      el('p', { class: 'field-note', text: 'チェックを外した姓は「日本の姓」として扱われ、その姓の方は候補に出なくなります。' }),
      list,
    ]);
  }

  /** 辞書の設定が変わったら候補を選び直す */
  function refreshCandidates(rule) {
    rule.values = nameCandidates(rule.columnIndex).results
      .filter((r) => window.NameHint.isCandidate(r.level)).map((r) => r.value);
    renderRules();
    recompute();
  }

  /** 氏名の表記で仕分けした一覧 */
  function renderNameGroups(rule, box) {
    box.appendChild(dictControl(rule));
    const cls = nameCandidates(rule.columnIndex);

    cls.warnings.forEach((w) => box.appendChild(el('p', { class: 'warn-note', text: '⚠ ' + w })));

    window.NameHint.GROUPS.forEach((group) => {
      const rows = cls.results.filter((r) => r.level === group.key);
      if (!rows.length) return;
      const people = rows.reduce((a, r) => a + r.count, 0);

      const check = (on) => {
        rows.forEach((r) => {
          const has = rule.values.includes(r.value);
          if (on && !has) rule.values.push(r.value);
          if (!on && has) rule.values = rule.values.filter((v) => v !== r.value);
        });
        renderRules();
        recompute();
      };

      const header = el('div', { class: 'name-group-head' }, [
        el('span', { class: 'name-group-title', text: group.title }),
        el('span', { class: 'count', text: people + ' 人' }),
        el('button', { type: 'button', class: 'btn-link', text: 'まとめて除外', onclick: () => check(true) }),
        el('button', { type: 'button', class: 'btn-link', text: '解除', onclick: () => check(false) }),
      ]);

      const list = el('div', { class: 'rule-values' });
      rows.forEach((r) => list.appendChild(valueCheckbox(rule, r.value, r.count, r.reason)));

      box.appendChild(el('div', { class: 'name-group level-' + group.key }, [
        header,
        group.note ? el('p', { class: 'field-note', text: group.note }) : null,
        list,
      ]));
    });
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

      const mode = el('select');
      mode.appendChild(el('option', { value: 'value', text: '値を選んで除外' }));
      mode.appendChild(el('option', { value: 'name', text: '氏名の表記から候補を出す' }));
      mode.value = rule.mode || 'value';
      mode.addEventListener('change', () => {
        rule.mode = mode.value;
        rule.values = rule.mode === 'name' && rule.columnIndex >= 0
          ? nameCandidates(rule.columnIndex).results
            .filter((r) => window.NameHint.isCandidate(r.level)).map((r) => r.value)
          : [];
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
        el('label', { class: 'field' }, [el('span', { text: '判定のしかた' }), mode]),
        el('label', { class: 'field' }, [el('span', { text: '部分一致で除外（任意）' }), keyword]),
        remove,
      ]);

      const box = el('div', { class: 'rule' }, [head]);

      if (rule.columnIndex >= 0 && rule.mode === 'name') {
        renderNameGroups(rule, box);
      } else if (rule.columnIndex >= 0) {
        const counts = window.Rating.valueCounts(state.table, rule.columnIndex);
        const list = el('div', { class: 'rule-values' });
        if (counts.length > 300) {
          list.appendChild(el('span', {
            class: 'field-note',
            text: '値の種類が多すぎます (' + counts.length + ' 種)。'
              + '氏名の列なら「氏名の表記から候補を出す」を、それ以外は部分一致の欄をお使いください。',
          }));
        } else {
          counts.forEach((entry) => list.appendChild(valueCheckbox(rule, entry.value, entry.count)));
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
    renderQuick();

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

  function downloadBlob(blob, filename) {
    const a = el('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  async function copyMatrix(rows, note) {
    const text = rows.map((r) => r.join('\t')).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      note.textContent = 'コピーしました。Excel に貼り付けられます。';
    } catch (e) {
      note.textContent = 'コピーできませんでした。CSV 保存をお使いください。';
    }
    setTimeout(() => { note.textContent = ''; }, 4000);
  }

  function exportCsv() {
    if (!state.result || !state.result.rows.length) return;
    // Excel で開いたときに文字化けしないよう BOM を付ける
    const blob = new Blob(['﻿' + toCsv(resultMatrix())], { type: 'text/csv;charset=utf-8' });
    const base = (state.fileName || '評価').replace(/\.[^.]+$/, '');
    downloadBlob(blob, base + '_評価.csv');
  }

  async function copyTsv() {
    if (!state.result || !state.result.rows.length) return;
    await copyMatrix(resultMatrix(), $('action-note'));
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

    $('quick-csv').addEventListener('click', exportQuickCsv);
    $('quick-copy').addEventListener('click', copyQuick);
    $('quick-drop-col').addEventListener('change', (e) => {
      state.quickDropColumn = e.target.checked;
      renderQuick();
    });

    $('export-csv').addEventListener('click', exportCsv);
    $('copy-tsv').addEventListener('click', copyTsv);
    $('print').addEventListener('click', () => window.print());
  }

  bind();
})();
