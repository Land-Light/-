/* rating.js — 表の整形・除外フィルタ・評価（得点／偏差値／順位／5段階）の計算 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------- 表の組み立て */

  function isBlankRow(cells) {
    return !cells || cells.every((c) => c === null || c === undefined || c === '');
  }

  /** 見出しらしい行（最初に「2つ以上の値が埋まっている行」）を推測する */
  function guessHeaderRow(rows) {
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const filled = (rows[i] || []).filter((c) => c !== null && c !== undefined && c !== '');
      if (filled.length >= 2) return i;
    }
    return 0;
  }

  function columnLabel(index) {
    let label = '';
    let n = index + 1;
    while (n > 0) {
      const rem = (n - 1) % 26;
      label = String.fromCharCode(65 + rem) + label;
      n = Math.floor((n - 1) / 26);
    }
    return label;
  }

  /**
   * 生の 2 次元配列から、見出し・レコード・列情報を作る。
   * headerRow より下をデータ行として扱う。
   */
  function buildTable(rows, headerRow) {
    const header = rows[headerRow] || [];
    let width = header.length;
    for (let i = headerRow + 1; i < rows.length; i++) {
      width = Math.max(width, (rows[i] || []).length);
    }

    const used = new Map();
    const headers = [];
    for (let c = 0; c < width; c++) {
      let name = header[c] === null || header[c] === undefined ? '' : String(header[c]).trim();
      if (!name) name = '列' + columnLabel(c);
      if (used.has(name)) {
        const n = used.get(name) + 1;
        used.set(name, n);
        name = name + ' (' + n + ')';
      } else used.set(name, 1);
      headers.push(name);
    }

    const records = [];
    for (let r = headerRow + 1; r < rows.length; r++) {
      const cells = rows[r] || [];
      if (isBlankRow(cells)) continue;
      const values = [];
      for (let c = 0; c < width; c++) {
        const v = cells[c];
        values.push(v === undefined || v === '' ? null : v);
      }
      records.push({ sourceRow: r + 1, values });
    }

    const columns = headers.map((name, index) => {
      let numeric = 0;
      let filled = 0;
      const uniq = new Set();
      for (const rec of records) {
        const v = rec.values[index];
        if (v === null) continue;
        filled++;
        if (typeof v === 'number' && isFinite(v)) numeric++;
        if (uniq.size <= 200) uniq.add(String(v));
      }
      return {
        index,
        name,
        letter: columnLabel(index),
        filled,
        numericRatio: filled ? numeric / filled : 0,
        isNumeric: filled > 0 && numeric / filled >= 0.8,
        uniqueCount: uniq.size,
      };
    });

    return { headers, columns, records };
  }

  /** 指定列の値ごとの件数（多い順） */
  function valueCounts(table, columnIndex) {
    const map = new Map();
    for (const rec of table.records) {
      const v = rec.values[columnIndex];
      const key = v === null ? '(空欄)' : String(v);
      map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'ja'));
  }

  /* --------------------------------------------------------- 除外フィルタ */

  /**
   * rules: [{ columnIndex, values: [文字列], keyword: 部分一致文字列 }]
   * いずれかのルールに当てはまった行を除外する。
   */
  function applyFilters(table, rules) {
    const kept = [];
    const removed = [];
    const active = (rules || []).filter(
      (r) => r && r.columnIndex >= 0 && ((r.values && r.values.length) || (r.keyword || '').trim())
    );

    for (const rec of table.records) {
      let hitRule = null;
      for (const rule of active) {
        const raw = rec.values[rule.columnIndex];
        const text = raw === null ? '(空欄)' : String(raw);
        const byValue = rule.values && rule.values.includes(text);
        const kw = (rule.keyword || '').trim();
        const byKeyword = kw && text.toLowerCase().includes(kw.toLowerCase());
        if (byValue || byKeyword) { hitRule = rule; break; }
      }
      if (hitRule) removed.push({ record: rec, rule: hitRule });
      else kept.push(rec);
    }
    return { kept, removed, activeRules: active };
  }

  /** 「国籍」「区分」などの列と、除外候補になりそうな値を推測する */
  const COLUMN_HINT = /国籍|nationality|国別|内外|外国|出身国|citizenship|区分/i;
  const FOREIGN_HINT = /外国|海外|foreign|overseas|非日本|日本以外|留学生|外国人/i;

  function suggestFilter(table) {
    const col = table.columns.find(
      (c) => COLUMN_HINT.test(c.name) && c.uniqueCount > 0 && c.uniqueCount <= 100
    );
    if (!col) return null;
    const values = valueCounts(table, col.index)
      .filter((v) => FOREIGN_HINT.test(v.value))
      .map((v) => v.value);
    return { columnIndex: col.index, values, keyword: '' };
  }

  /* ------------------------------------------------------------- 統計 */

  function mean(nums) {
    if (!nums.length) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }

  /** 標準偏差（母集団）。読み込んだ集団そのものを評価対象とするため n で割る */
  function stdev(nums, m) {
    if (nums.length < 2) return 0;
    const avg = m === undefined ? mean(nums) : m;
    return Math.sqrt(nums.reduce((a, b) => a + (b - avg) * (b - avg), 0) / nums.length);
  }

  function toNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string') {
      const n = Number(v.replace(/,/g, '').replace(/[%点]/g, ''));
      if (v.trim() !== '' && isFinite(n)) return n;
    }
    return null;
  }

  /** 偏差値 = 50 + 10 × z。標準偏差 0 のときは全員 50 */
  function tScore(value, m, sd) {
    if (!sd) return 50;
    return 50 + 10 * ((value - m) / sd);
  }

  const GRADE_LABELS = {
    number: ['5', '4', '3', '2', '1'],
    alpha: ['A', 'B', 'C', 'D', 'E'],
  };

  /** 相対評価の既定配分（正規分布に沿った 7 : 24 : 38 : 24 : 7 ％） */
  const DEFAULT_SHARES = [7, 24, 38, 24, 7];

  function relativeGrade(rank, total, shares) {
    const s = shares && shares.length === 5 ? shares : DEFAULT_SHARES;
    const sum = s.reduce((a, b) => a + b, 0) || 100;
    const ratio = total ? rank / total : 1; // 上位からの割合 (0〜1]
    let acc = 0;
    for (let i = 0; i < 5; i++) {
      acc += s[i] / sum;
      if (ratio <= acc + 1e-9) return i;
    }
    return 4;
  }

  /** 絶対評価: 偏差値のしきい値（既定 60 / 55 / 45 / 40） */
  function absoluteGrade(t, thresholds) {
    const th = thresholds && thresholds.length === 4 ? thresholds : [60, 55, 45, 40];
    if (t >= th[0]) return 0;
    if (t >= th[1]) return 1;
    if (t >= th[2]) return 2;
    if (t >= th[3]) return 3;
    return 4;
  }

  /**
   * 評価を計算する。
   * options = {
   *   items: [{ columnIndex, weight }],   // 評価に使う数値列と重み
   *   standardize: bool,                  // 項目ごとに偏差値化してから合計するか
   *   labelColumns: [列番号],             // 結果表に添える氏名・ID などの列
   *   gradeMode: 'relative' | 'absolute',
   *   shares: [5つの％], thresholds: [4つの偏差値],
   *   gradeLabel: 'number' | 'alpha',
   * }
   */
  function evaluate(records, options) {
    const items = (options.items || []).filter((it) => it && it.columnIndex >= 0);
    if (!items.length) return { rows: [], items: [], stats: null, skipped: [] };

    // 項目ごとの平均・標準偏差（対象者だけで算出）
    const itemStats = items.map((it) => {
      const nums = [];
      for (const rec of records) {
        const n = toNumber(rec.values[it.columnIndex]);
        if (n !== null) nums.push(n);
      }
      const m = mean(nums);
      return {
        columnIndex: it.columnIndex,
        weight: Number(it.weight) || 0,
        count: nums.length,
        mean: m,
        sd: stdev(nums, m),
        min: nums.length ? Math.min(...nums) : 0,
        max: nums.length ? Math.max(...nums) : 0,
      };
    });

    const weightSum = itemStats.reduce((a, b) => a + b.weight, 0);
    const rows = [];
    const skipped = [];

    for (const rec of records) {
      const scores = [];
      let total = 0;
      let missing = 0;
      itemStats.forEach((st) => {
        const n = toNumber(rec.values[st.columnIndex]);
        scores.push(n);
        if (n === null) { missing++; return; }
        const contrib = options.standardize ? tScore(n, st.mean, st.sd) : n;
        total += contrib * st.weight;
      });
      if (missing === itemStats.length) {
        skipped.push(rec); // 評価項目が 1 つも入力されていない行
        continue;
      }
      rows.push({ record: rec, scores, missing, total: weightSum ? total : 0 });
    }

    // 総合点の分布から偏差値・順位・評価を求める
    const totals = rows.map((r) => r.total);
    const m = mean(totals);
    const sd = stdev(totals, m);

    const order = [...rows].sort((a, b) => b.total - a.total);
    let lastTotal = null;
    let lastRank = 0;
    order.forEach((row, i) => {
      const rank = (lastTotal !== null && Math.abs(row.total - lastTotal) < 1e-9) ? lastRank : i + 1;
      row.rank = rank;
      lastTotal = row.total;
      lastRank = rank;
    });

    const labels = GRADE_LABELS[options.gradeLabel] || GRADE_LABELS.number;
    for (const row of order) {
      row.tScore = tScore(row.total, m, sd);
      row.percentile = order.length ? (1 - (row.rank - 1) / order.length) * 100 : 100;
      const gi = options.gradeMode === 'absolute'
        ? absoluteGrade(row.tScore, options.thresholds)
        : relativeGrade(row.rank, order.length, options.shares);
      row.gradeIndex = gi;
      row.grade = labels[gi];
    }

    const distribution = labels.map((label, i) => ({
      label,
      count: order.filter((r) => r.gradeIndex === i).length,
    }));

    return {
      rows: order,
      items: itemStats,
      skipped,
      stats: { count: order.length, mean: m, sd, max: order.length ? order[0].total : 0,
        min: order.length ? order[order.length - 1].total : 0, distribution },
    };
  }

  global.Rating = {
    guessHeaderRow, buildTable, columnLabel, valueCounts,
    applyFilters, suggestFilter,
    evaluate, toNumber, mean, stdev, tScore,
    DEFAULT_SHARES, GRADE_LABELS,
  };
})(window);
