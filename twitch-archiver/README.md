# Twitch → YouTube 自動アーカイブ

Twitch の [paseriman2](https://www.twitch.tv/paseriman2) さんの配信を自動で録画し、
配信が終わったら YouTube にアップロードする常駐プログラムです。

- 1 分ごとに配信中か確認し、始まったら自動で録画
- 回線切れで途切れても、5 分以内に再開すればひとつの動画にまとめる
- 配信終了後に mp4 に変換 (再エンコードなし) して YouTube にアップロード
- タイトルは「配信タイトル 【日付】」、説明文にカテゴリや配信日時を入れる
- 12 時間を超える配信は自動で分割 (Part 1/2 …)
- アップロードに失敗したり API の 1 日の上限に達したりしても、時間をおいて自動で再試行
- 強制終了しても、次に起動したときに残っていた録画をアップロードする

> 録画した配信を YouTube に上げるときは、配信者さんの許可を取ってください。
> 公開設定は既定で **非公開 (private)** です。

## 必要なもの

- 24 時間動かしておけるパソコンやサーバー (VPS、自宅 PC、Raspberry Pi など)
- 録画を一時的に置くディスク (1080p60 でおよそ 1 時間 3〜4 GB)
- Docker、または Python 3.10 以上 + ffmpeg
- Google アカウント (アップロード先の YouTube チャンネル)

GitHub Actions は 1 回 6 時間までしか動かせず、長い配信を取りこぼすので使っていません。

## 1. YouTube API の準備 (最初に 1 回だけ)

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作る
2. 「API とサービス」→「ライブラリ」で **YouTube Data API v3** を有効にする
3. 「OAuth 同意画面」を作る
   - User Type は「外部」、テストユーザーに自分の Google アカウントを追加
   - 作り終わったら **「アプリを公開」で公開ステータスを「本番環境」にする**。
     「テスト」のままだと 7 日で認証が切れ、アップロードが止まります
     (本番環境にしても審査は不要で、自分で使う分には警告画面が出るだけです)
4. 「認証情報」→「認証情報を作成」→「OAuth クライアント ID」→ 種類「デスクトップアプリ」
5. JSON をダウンロードし、`data/client_secret.json` として置く

## 2. YouTube の認証 (最初に 1 回だけ)

ブラウザが使えるパソコンで:

```sh
cd twitch-archiver
pip install -r requirements.txt
python youtube_auth.py
```

ブラウザが開くので、アップロード先のチャンネルのアカウントで許可します。
`data/token.json` ができれば完了です。サーバーで動かす場合は、この `data/` フォルダを
サーバーにコピーしてください。

## 3. 設定

```sh
cp .env.example .env
```

`.env` を開いて、公開設定 (`PRIVACY`) やタイトルの形 (`TITLE_TEMPLATE`) などを必要に応じて変えます。
何も変えなくても paseriman2 さんの配信を非公開でアップロードする設定になっています。

| 設定 | 既定値 | 内容 |
| --- | --- | --- |
| `TWITCH_CHANNEL` | `paseriman2` | 監視するチャンネル |
| `QUALITY` | `best` | 画質 (`720p60` などにすると容量を節約できる) |
| `POLL_INTERVAL` | `60` | 配信中か確認する間隔 (秒) |
| `RECONNECT_GRACE` | `300` | この秒数以内に再開した配信はひとつにまとめる |
| `TITLE_TEMPLATE` | `{title} 【{date}】` | `{title}` `{category}` `{date}` `{datetime}` `{channel}` が使える |
| `PRIVACY` | `private` | `private` / `unlisted` / `public` |
| `PLAYLIST_ID` | (空) | 指定すると再生リストにも追加 |
| `DELETE_AFTER_UPLOAD` | `true` | アップロード後に手元の動画を消す |
| `UPLOAD_ENABLED` | `true` | `false` で録画だけ行う |
| `TWITCH_OAUTH_TOKEN` | (空) | サブスク済みアカウントの `auth-token` Cookie を入れると広告なしで録画できる |

## 4. 起動

### Docker の場合 (おすすめ)

```sh
docker compose up -d --build
docker compose logs -f     # 動いているか確認
```

`restart: unless-stopped` なので、サーバーを再起動しても自動で立ち上がります。

### Docker を使わない場合

```sh
sudo apt install ffmpeg        # Mac なら brew install ffmpeg
pip install -r requirements.txt
set -a; . ./.env; set +a
python archiver.py
```

常駐させるなら systemd などに登録してください。例 (`/etc/systemd/system/twitch-archiver.service`):

```ini
[Unit]
Description=Twitch to YouTube archiver
After=network-online.target

[Service]
WorkingDirectory=/home/you/twitch-archiver
EnvironmentFile=/home/you/twitch-archiver/.env
ExecStart=/usr/bin/python3 archiver.py
Restart=always

[Install]
WantedBy=multi-user.target
```

## フォルダの中身

```
data/
  client_secret.json   Google Cloud の OAuth クライアント
  token.json           YouTube の認証情報 (自動で更新される)
  recordings/          録画中・アップロード待ちの動画
  queue/               アップロード待ちの一覧 (1 本につき 1 ファイル)
  uploaded.log         アップロードした動画の記録 (YouTube の ID 付き)
```

## 注意点

- **YouTube API の上限**: 1 日に使える量 (10,000) のうち、動画 1 本のアップロードで 1,600 使うため、
  1 日 6 本程度までです。超えた分は翌日に自動で再試行します。
- **API の監査**: Google の監査を受けていない API プロジェクトからアップロードした動画は、
  **非公開に固定される**ことがあります。公開したい場合は YouTube Studio から手動で公開に切り替えるか、
  [監査を申請](https://support.google.com/youtube/contact/yt_api_form)してください。
- **長い動画**: YouTube チャンネルの電話番号確認をしていないと 15 分を超える動画を上げられません。
  [こちら](https://www.youtube.com/verify)で確認しておいてください。
- **広告**: 配信中に Twitch の広告が入った部分は録画から抜けます。

## テスト

```sh
python -m unittest -v
```
