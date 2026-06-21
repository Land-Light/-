import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, loadAliases, makeScheduleItem } from './config.js';
import { runApply } from './run.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);

let running = false; // 同時実行を防ぐ

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // 画面
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'));
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    // 略称・設定情報
    if (req.method === 'GET' && req.url === '/api/config') {
      const aliases = loadAliases();
      return send(
        res,
        200,
        JSON.stringify({
          aliases,
          scheduleUrlSet: Boolean(config.scheduleUrl),
        })
      );
    }

    // 申請実行
    if (req.method === 'POST' && req.url === '/api/apply') {
      if (running) return send(res, 409, JSON.stringify({ ok: false, message: '実行中です。完了までお待ちください。' }));

      const body = JSON.parse((await readBody(req)) || '{}');
      const dryRun = Boolean(body.dryRun);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (rows.length === 0) {
        return send(res, 400, JSON.stringify({ ok: false, message: '申請する行がありません。' }));
      }

      let schedules;
      try {
        const aliases = loadAliases();
        schedules = rows.map((r, i) => {
          try {
            return makeScheduleItem(r, aliases);
          } catch (e) {
            throw new Error(`${i + 1}行目: ${e.message}`);
          }
        });
      } catch (e) {
        return send(res, 400, JSON.stringify({ ok: false, message: e.message }));
      }

      running = true;
      const logs = [];
      try {
        const result = await runApply(schedules, { dryRun, onLog: (l) => logs.push(l) });
        return send(res, 200, JSON.stringify({ ...result, logs }));
      } catch (e) {
        return send(res, 500, JSON.stringify({ ok: false, message: e.message, logs }));
      } finally {
        running = false;
      }
    }

    send(res, 404, JSON.stringify({ message: 'not found' }));
  } catch (e) {
    send(res, 500, JSON.stringify({ ok: false, message: e.message }));
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n✓ スケジュール申請ツールを起動しました`);
  console.log(`  ブラウザで開いてください → ${url}\n`);
  if (!config.scheduleUrl) {
    console.log('※ .env の OFS_SCHEDULE_URL が未設定です。設定すると申請画面を確実に開けます。\n');
  }
  // 可能なら自動でブラウザを開く（Windows/mac/Linux）
  openBrowser(url);
});

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'win32' ? 'start ""' : platform === 'darwin' ? 'open' : 'xdg-open';
  import('node:child_process').then(({ exec }) => {
    exec(`${cmd} ${url}`, () => {});
  });
}
