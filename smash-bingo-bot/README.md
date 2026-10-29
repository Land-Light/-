# スマブラ キャラビンゴ Discord ボット

スマブラSPのファイターをランダムに並べたビンゴカードを作る Discord ボットです。
マスはキャラアイコン付きの画像で表示され、カード下のボタンを押すとマークできます。

![カードの例](docs/example.png)

## できること

- `/bingo` … ビンゴカードを作る（3×3 〜 5×5）
- `/reroll` … 同じ設定で引き直す
- `/reset` … マークを全部消す
- `/fighters` … 抽選候補のキャラ一覧を見る
- `/bingohelp` … 使い方を見る

`/bingo` のオプション:

| オプション | 既定 | 内容 |
| --- | --- | --- |
| `マス` | 5 | 1辺のマス数（3〜5） |
| `追加ファイター` | 入れる | パックンフラワー以降のDLC |
| `ダッシュファイター` | 入れる | ルキナ・クロム・ケンなど |
| `mii` | 入れない | Miiファイター3種 |
| `まんなかfree` | しない | 中央をFREEマスにする |
| `除外` | なし | 例: `マリオ, カズヤ, ソラ` |
| `みんなで` | しない | 他の人もマークできるようにする |
| `seed` | なし | 同じ文字で同じカードが出る |

マークはボタンを押すたびに付け外しでき、縦横斜めがそろうと自動で知らせます。

## 準備

1. [Discord Developer Portal](https://discord.com/developers/applications) で
   アプリケーションを作り、Bot のトークンを取得します。
2. OAuth2 の招待URLを作ってサーバーに入れます。必要なのは次の2つだけです。
   - スコープ: `bot`, `applications.commands`
   - 権限: `Send Messages`, `Attach Files`
   - メッセージ内容の読み取り（Message Content Intent）は不要です。

## 動かす

```bash
cd smash-bingo-bot
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

cp .env.example .env     # .env にトークンを書く
set -a && . ./.env && set +a
.venv/bin/python -m smashbingo
```

常時動かすなら systemd や Docker、各種ホスティングに載せてください。
カードの状態は `data/cards.json` に保存されるので、再起動してもボタンは動きます。

## キャラアイコンについて

`assets/icons/` のアイコンは、元のアイコンシート（`assets/_src/`）から
`scripts/extract_icons.py` で切り出したものです。シートを差し替えたときは:

```bash
python3 scripts/extract_icons.py
```

シートは2枚あります。`sheet.jpg`（7列×16行）が本体で、カズヤとソラだけは
これに入っていないため `sheet2.jpg`（8列×15行）の最終行から取っています。
どちらもカラーバリエーション（ナナ、ポケモン、コクッパ、勇者の別主人公など）が
1枠ずつ入っているので、代表の1枚だけを各ファイターに割り当てています。

## カードの画像だけ試す

Discord を使わずに画像の出来を確認できます。

```bash
.venv/bin/python scripts/preview.py preview.png 5
```

## ファイル

| パス | 役割 |
| --- | --- |
| `smashbingo/fighters.py` | 全86ファイターのデータとアイコンの対応 |
| `smashbingo/bingo.py` | カードの抽選・マーク・ビンゴ判定 |
| `smashbingo/render.py` | カード画像の描画 |
| `smashbingo/storage.py` | カードの保存・読み込み |
| `smashbingo/bot.py` | スラッシュコマンドとボタン |
| `scripts/extract_icons.py` | アイコンシートの切り出し |
| `scripts/preview.py` | 画像の試し描き |
