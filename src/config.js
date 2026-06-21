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
  loginId: required('OFS_LOGIN_ID'),
  password: required('OFS_PASSWORD'),
  headful: (process.env.HEADFUL ?? 'true').toLowerCase() !== 'false',
  actionDelayMs: Number(process.env.ACTION_DELAY_MS ?? 800),
};

/**
 * 申請対象スケジュールを CSV から読み込む。
 * @param {string} csvPath
 * @returns {Array<{date:string,start:string,end:string,breakStart:string,breakEnd:string,note:string}>}
 */
export function loadSchedules(csvPath) {
  const abs = path.isAbsolute(csvPath) ? csvPath : path.join(ROOT, csvPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`スケジュールCSVが見つかりません: ${abs}`);
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    comment: '#',
    trim: true,
  });

  return records.map((r, i) => {
    const row = { ...r };
    const date = row.date;
    const start = row.start;
    const end = row.end;
    if (!date || !start || !end) {
      throw new Error(`CSV ${i + 1}行目: date / start / end は必須です。`);
    }
    assertDate(date, i);
    assertTime(start, i, 'start');
    assertTime(end, i, 'end');
    if (row.break_start) assertTime(row.break_start, i, 'break_start');
    if (row.break_end) assertTime(row.break_end, i, 'break_end');
    return {
      date,
      start,
      end,
      breakStart: row.break_start || '',
      breakEnd: row.break_end || '',
      note: row.note || '',
    };
  });
}

function assertDate(v, i) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(`CSV ${i + 1}行目: date は YYYY-MM-DD 形式にしてください: "${v}"`);
  }
}

function assertTime(v, i, field) {
  if (!/^\d{1,2}:\d{2}$/.test(v)) {
    throw new Error(`CSV ${i + 1}行目: ${field} は HH:MM 形式にしてください: "${v}"`);
  }
}
