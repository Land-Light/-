# オフィスステーション勤怠 スケジュール申請 自動化ツール

[オフィスステーション勤怠](https://attendance.officestation.jp/) の管理画面に対し、
**日々の勤務スケジュール（出勤/退勤時刻）の申請を自動化**する Node.js + Playwright 製ツールです。

> オフィスステーション勤怠には外部連携用の公開APIが無いため、ブラウザ操作（Playwright）で
> 実際の画面を操作して申請します。

---

## セットアップ

```bash
npm install            # 依存関係 + Chromium を取得（postinstall で playwright install）
cp .env.example .env    # 認証情報を設定
cp data/schedules.example.csv data/schedules.csv
```

`.env` を編集：

| 変数 | 説明 |
|------|------|
| `OFS_ADMIN_URL` | 管理画面の入口URL（トークン付き。**秘密情報**） |
| `OFS_LOGIN_ID` / `OFS_PASSWORD` | ログイン情報 |
| `HEADFUL` | `true` でブラウザ画面を表示（デバッグ向き） |
| `ACTION_DELAY_MS` | 各操作の間の待機ミリ秒 |

---

## ★ 最初にやること：画面のセレクタを埋める

このツールは「処理の流れ」はできていますが、**実際のボタン/入力欄の指定（セレクタ）は
`src/selectors.js` に空欄（TODO）で入っています**。実画面に合わせて埋める必要があります。

### 手順A: HTMLを保存して貼る（推奨）

```bash
npm run dump
```

ブラウザが開くので、**手動でログイン → スケジュール申請画面まで進め**、ターミナルで Enter。
`captures/` に HTML とスクショが保存されます。この中身を共有すれば、`src/selectors.js` を
正確に埋められます。

### 手順B: Playwright codegen で操作を記録

```bash
npm run codegen -- "$OFS_ADMIN_URL"
```

実際に操作すると、対応するセレクタ付きのコードが生成されます。それを `src/selectors.js` に反映します。

---

## 実行

```bash
# まずは送信せずに動作確認（フォーム入力まで行い、申請ボタンは押さない）
npm run apply:dry

# 本番（申請を送信）
npm run apply

# CSV を指定したい場合
node src/index.js --csv=data/2026-07.csv
```

### スケジュールCSV (`data/schedules.csv`)

```csv
date,start,end,break_start,break_end,note
2026-06-23,09:00,18:00,12:00,13:00,
2026-06-24,10:00,19:00,13:00,14:00,午前通院のため遅め
```

- `date` … 申請対象日 `YYYY-MM-DD`
- `start` / `end` … 出勤/退勤 `HH:MM`
- `break_start` / `break_end` … 休憩（任意）
- `note` … 申請メッセージ（任意）
- 先頭が `#` の行・空行は無視されます。

---

## 仕組み / ファイル構成

| ファイル | 役割 |
|----------|------|
| `src/index.js` | エントリポイント。CSV読込→ログイン→各日を申請 |
| `src/config.js` | `.env` 読込・CSV パースとバリデーション |
| `src/browser.js` | Playwright 起動（セッションを `.pw-profile/` に永続化） |
| `src/login.js` | ログイン（既ログインなら自動スキップ） |
| `src/applySchedule.js` | 申請画面への遷移・1日分の申請 |
| `src/selectors.js` | **★画面セレクタの一元管理（ここを埋める）** |
| `src/dumpPage.js` | セレクタ調査用に画面HTMLを保存 |

セッションは `.pw-profile/` に保存されるため、一度ログインすれば次回以降は
ログイン操作を省略できます（多要素認証がある場合に特に有効）。

---

## 注意

- このツールは**自分自身の勤怠申請を効率化する目的**で使ってください。
- `.env` / `data/schedules.csv` / `.pw-profile/` / `captures/` は `.gitignore` 済みです。
  認証情報やトークンを誤ってコミットしないよう注意してください。
- 画面仕様が変わるとセレクタの更新が必要です。
