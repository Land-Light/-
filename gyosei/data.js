/* =====================================================
   行政法 ○×演習 — 問題データ
   問題を追加する場合は下記の形式で DATA, ANSWERS, TOPICS に追記してください。

   DATA[年度] = [
     ["問題文", "解説キー"],
     ...
   ]

   ANSWERS[年度] = [1または2, ...]   1 = 正しい  2 = 誤り

   TOPICS = [各問に対応するトピック名, ...]

   EXPLAIN = { 解説キー: "解説文", ... }
   ===================================================== */

const ANSWERS = {
  // 例: 2025: [1, 2, 1, ...]
};

const TOPICS = [
  // 例: "行政行為", "行政裁量", ...
];

const EXPLAIN = {
  // 例: sample: "行政行為とは、行政庁が法律に基づき公権力を行使して国民の権利義務を具体的に決定する行為をいう。"
};

const DATA = {
  // 例:
  // 2025: [
  //   ["行政行為とは…（問題文）", "sample"],
  // ]
};

const QUESTIONS = Object.entries(DATA).flatMap(([year, rows]) =>
  rows.map(([text, key], i) => ({
    id: `${year}-${i + 1}`,
    idNum: Number(year) * 100 + i + 1,
    year: Number(year),
    no: i + 1,
    text,
    answer: (ANSWERS[year] || [])[i],
    topic: TOPICS[i] || "行政法",
    explanation: `${(ANSWERS[year] || [])[i] === 1 ? "正しい" : "誤り"}（${(ANSWERS[year] || [])[i]}）。${EXPLAIN[key] || ""}`
  }))
);
