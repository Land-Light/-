import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`環境変数 ${name} が未設定です。.env を確認してください（.env.example を参照）。`);
  }
  return v.trim();
}

export const config = {
  adminUrl: required('OFS_ADMIN_URL'),
  // スケジュール申請ページのURL（ブラウザのアドレスバーからコピー）。空なら adminUrl を使う。
  scheduleUrl: (process.env.OFS_SCHEDULE_URL || '').trim(),
  headful: (process.env.HEADFUL ?? 'true').toLowerCase() !== 'false',
  actionDelayMs: Number(process.env.ACTION_DELAY_MS ?? 800),
};

/** 略称(A/B等)→実シフト名の対応表を読み込む */
export function loadAliases() {
  const p = path.join(ROOT, 'data', 'aliases.json');
  if (!fs.existsSync(p)) return {};
  const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
  delete obj._comment;
  return obj;
}

/**
 * 1行分の生データ({date,pattern,working_day_type,note})を申請アイテムに変換する。
 * pattern は略称(A/B)でも実シフト名でも可。
 */
export function makeScheduleItem(row, aliases = loadAliases()) {
  const date = (row.date || '').trim();
  const pattern = (row.pattern || '').trim();
  if (!date || !pattern) throw new Error('date と pattern は必須です。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`date は YYYY-MM-DD 形式にしてください: "${date}"`);
  }
  return {
    date,
    ymd: date.replace(/-/g, ''),
    pattern: aliases[pattern] ?? pattern,
    patternRaw: pattern,
    workingDayType: (row.working_day_type || '').trim(),
    note: (row.note || '').trim(),
  };
}

/**
 * 申請対象スケジュールを CSV から読み込む。
 * pattern欄は略称(A/B)でも実シフト名でも可。略称は data/aliases.json で解決。
 * @param {string} csvPath
 * @returns {Array<{date:string, ymd:string, pattern:string, workingDayType:string, note:string}>}
 */
export function loadSchedules(csvPath) {
  const abs = path.isAbsolute(csvPath) ? csvPath : path.join(ROOT, csvPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`スケジュールCSVが見つかりません: ${abs}`);
  }
  const aliases = loadAliases();
  const raw = fs.readFileSync(abs, 'utf8');
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    comment: '#',
    trim: true,
  });

  return records.map((r, i) => {
    try {
      return makeScheduleItem(r, aliases);
    } catch (e) {
      throw new Error(`CSV ${i + 1}行目: ${e.message}`);
    }
  });
}
