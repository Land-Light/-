import { normalizeJan, normalizeKey, toInt, digitsOnly } from "./util.js";

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(text || "").replace(/^\ufeff/, "");

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "\"") {
      if (quoted && next === "\"") {
        cell += "\"";
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function findCsvColumn(headers, names) {
  const normalized = names.map(normalizeKey);
  return headers.findIndex((header) => normalized.includes(normalizeKey(header)));
}

function findCsvColumnWhere(headers, names, predicate) {
  const normalized = names.map(normalizeKey);
  return headers.findIndex((header) => normalized.includes(normalizeKey(header)) && predicate(header));
}

function isMoneyHeader(value) {
  return /金額|価格|単価|原価|売価|販売|税|price|amount|cost|yen|円/i.test(String(value || ""));
}

export function codeCellScore(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const digits = digitsOnly(text);
  if ([8, 12, 13, 14].includes(digits.length)) return 5;
  if (/^\d+$/.test(text) && digits.length >= 5 && digits.length <= 20) return 3;
  if (/^[A-Z0-9_-]{4,}$/i.test(text) && /\d/.test(text)) return 1;
  return 0;
}

function textCellScore(value) {
  const text = String(value || "").trim();
  if (!text || codeCellScore(text) >= 3) return 0;
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}A-Za-z]/u.test(text)) return Math.min(text.length, 30);
  return 0;
}

function guessCsvColumn(rows, scorer, excluded = new Set()) {
  let bestIndex = -1;
  let bestScore = 0;
  const width = Math.max(0, ...rows.map((row) => row.length));
  for (let index = 0; index < width; index += 1) {
    if (excluded.has(index)) continue;
    const score = rows.reduce((sum, row) => sum + scorer(row[index]), 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestScore > 0 ? bestIndex : -1;
}

function extractCombinedProductCell(value) {
  const text = String(value || "").trim();
  if (!text) return { code: "", name: "" };
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidates = [...text.matchAll(/[0-9]{4,20}/g)]
    .map((match) => match[0])
    .sort((a, b) => codeCellScore(b) - codeCellScore(a) || b.length - a.length);
  const code = candidates[0] || "";
  const nameLine = lines.find((line) => textCellScore(line) > 0 && !line.includes(code)) ||
    lines.find((line) => textCellScore(line) > 0) ||
    "";
  const name = code ? nameLine.replace(code, "").replace(/^[\s\-/:：・|]+|[\s\-/:：・|]+$/g, "").trim() : nameLine;
  return { code, name };
}

const JAN_HEADERS = [
  "jan", "janコード", "jancode", "barcode", "bar_code", "code", "sku", "plu",
  "コード", "バーコード", "商品コード", "商品cd", "商品ｃｄ", "品番",
  "品目コード", "品目cd", "品コード", "管理コード"
];

const NAME_HEADERS = [
  "name", "product", "item", "description", "title",
  "商品名", "商品名称", "品名", "品目名", "品目", "名称", "商品", "商品情報",
  "商品id商品コード商品名", "商品id/商品コード/商品名", "明細名", "内容"
];

const EXPECTED_HEADERS = [
  "expected", "stock", "qty", "quantity", "count",
  "予定数", "理論在庫", "在庫数", "帳簿在庫", "個数", "数量", "数", "在庫", "現在庫", "総数"
];

export function parseCsv(text, existingProducts = [], fallbackJanFromName) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];

  const headers = rows.shift();
  const headerJanIndex = findCsvColumn(headers, JAN_HEADERS);
  const headerNameIndex = findCsvColumn(headers, NAME_HEADERS);
  const expectedIndex = findCsvColumnWhere(headers, EXPECTED_HEADERS, (header) => !isMoneyHeader(header));
  const headerLooksLikeData = headerJanIndex < 0 && headerNameIndex < 0 && headers.some((cell) => codeCellScore(cell) >= 3);
  const dataRows = headerLooksLikeData ? [headers, ...rows] : rows;
  const janIndex = headerJanIndex >= 0 ? headerJanIndex : guessCsvColumn(dataRows, codeCellScore);
  const nameIndex = headerNameIndex >= 0 ? headerNameIndex : guessCsvColumn(dataRows, textCellScore, new Set([janIndex]));
  const productByJan = new Map(existingProducts.map((product) => [product.jan, product]));
  const productByName = new Map(existingProducts.map((product) => [normalizeKey(product.name), product]));

  if (janIndex < 0 && nameIndex < 0) return [];

  return dataRows.map((row) => {
    const janCell = janIndex >= 0 ? normalizeJan(row[janIndex]) : "";
    const nameCell = nameIndex >= 0 ? String(row[nameIndex] || "").trim() : "";
    const combined = extractCombinedProductCell(`${janCell}\n${nameCell}`);
    const rawJan = janCell && codeCellScore(janCell) >= 1 ? janCell : combined.code;
    const rawName = nameCell && textCellScore(nameCell) > 0 ? (combined.name || nameCell) : combined.name;
    const existing = productByJan.get(rawJan) || productByName.get(normalizeKey(rawName));
    const jan = rawJan || existing?.jan || (rawName ? fallbackJanFromName(rawName) : "");
    const name = rawName || existing?.name || rawJan;
    const expected = expectedIndex >= 0 && row[expectedIndex] !== ""
      ? toInt(row[expectedIndex])
      : existing?.expected || 0;
    return { jan, name, expected };
  }).filter((product) => product.jan && product.name);
}

export function buildCsv(header, rows) {
  return [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
}
