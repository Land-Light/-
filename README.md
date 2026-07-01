# kindle2pdf — Kindle 自動スクロール → PDF 化アプリ

Amazon Kindle（アプリ版）で開いた**自分が購入した本**を、ページを自動でめくりながら
1ページずつ画面キャプチャし、1つの PDF ファイルにまとめるデスクトップアプリです。
[SourceNext のスクリーンショット型 電子書籍→PDF 変換ソフト](https://www.sourcenext.com/product/0000014988/)
と同じ方式（画面をそのまま撮影して束ねる）で、**精度**と**作業速度**を最優先に設計しています。

> ⚠️ **利用上の注意 / Legal notice**
> このツールは、**あなた自身が正規に購入した書籍を、私的利用・バックアップ・
> アクセシビリティ目的で**扱うことを想定しています。DRM の回避や、著作物の
> 再配布・共有は行いません（画面に表示されている内容を撮影するだけです）。
> 各サービスの利用規約および著作権法を遵守してご利用ください。

---

## 特長（なぜ精度と速度が高いのか）

### 精度 (Accuracy)
- **描画完了フレームだけを撮影** — ページをめくった直後のアニメーション途中の
  ボケた画像を掴まないよう、画面の再描画が「止まった」瞬間を検知してから
  キャプチャします（`StableFrameWaiter`）。
- **ロスレス保存** — 各ページは PNG で保存し、`img2pdf` でそのまま PDF に埋め込みます。
  JPEG 再圧縮などの劣化は一切ありません。ピクセル等倍で本文がそのまま残ります。
- **末尾の自動検知** — ページをめくっても画面が変化しなくなったら「最終ページ」と
  判定して自動停止（`EndDetector`）。ページ数を数える必要がありません。
- **余白の自動トリミング** — リーダーの枠や余白を検出して切り落とし、
  本文だけのきれいなスキャンにします（任意でオフ可）。
- **OCR（任意）** — `ocrmypdf` があれば透明テキスト層を付与し、検索・コピー可能な
  PDF にできます（日本語＋英語対応）。

### 作業速度 (Speed)
- **`mss` による高速キャプチャ** — 1フレーム数ミリ秒。
- **軽量な差分比較** — 比較は 64×64 のグレースケール縮小画像に対して行うため、
  1回の判定が数マイクロ秒。ページが表示された瞬間に次へ進みます。
- **固定待機ではなく適応待機** — 「念のため長めに待つ」のではなく、
  再描画が止まった瞬間に撮影するので、速い端末では待ち時間ほぼゼロ。

---

## インストール

```bash
pip install -r requirements.txt      # 必須パッケージ
# 検索可能PDF（OCR）を使う場合のみ:
pip install ocrmypdf                  # + Tesseract 本体と言語データ(jpn/eng)
```

Python 3.9 以上。Windows / macOS / Linux（X11）対応。
macOS では初回に「画面収録」「アクセシビリティ」の権限許可が必要です。

## 使い方（GUI）

```bash
python -m kindle2pdf
```

1. Kindle アプリで本を開き、最初のページを表示しておく。
2. 撮影範囲を決める（どちらか）。
   - **全画面で読む場合（推奨・簡単）**: **「■ Use full screen」** を押すだけ。
     領域選択は不要です。そのまま **Start** でも自動的に全画面になります。
   - 一部だけ撮りたい場合: **「① Pick region」** で本文の領域をドラッグして囲む。
3. ページ送りキー（通常は `right`）・出力先などを設定。
4. **「▶ Start」** を押し、カウントダウン中に Kindle ウィンドウをクリックして
   前面（全画面）にしておく。あとは自動でめくりながら撮影 → PDF 化します。
5. 途中で止めたいときは **「■ Stop」**。最終ページに達すると自動停止します。

## 使い方（コマンドライン / 再実行向け）

領域が決まっていれば GUI なしで実行できます。

```bash
# 全画面をそのまま撮る（領域指定不要）
python -m kindle2pdf --fullscreen --key right --out mybook.pdf

# 領域(左 上 幅 高さ)を指定してそのまま実行
python -m kindle2pdf --region 120 80 1000 1400 --key right --out mybook.pdf

# 設定をプロファイルに保存 → 次回から使い回す
python -m kindle2pdf --region 120 80 1000 1400 --save-config profile.json
python -m kindle2pdf --config profile.json --out mybook.pdf --ocr
```

主なオプション:

| オプション | 説明 |
|---|---|
| `--region L T W H` | キャプチャ矩形（左・上・幅・高さ、ピクセル） |
| `--key` | ページ送りキー（`right` / `pagedown` / `space` …） |
| `--max-pages` | 安全上限のページ数 |
| `--settle` | ページめくり後の最小待機秒 |
| `--start-delay` | 開始前のカウントダウン秒 |
| `--no-autocrop` | 余白トリミングを無効化 |
| `--ocr` | 検索可能な透明テキスト層を付与（要 ocrmypdf） |
| `--keep-images` | 中間 PNG を残す |

## 仕組み

```
[画面領域] --mss--> フレーム
     │  StableFrameWaiter: 再描画が止まるまで待つ（精度）
     ▼
  ロスレスPNG保存 ──► EndDetector: 変化しなくなったら停止（末尾検知）
     │  （ページ送りキー/クリックで次へ）
     ▼
  autocrop（余白除去）──► img2pdf（ロスレス結合）──► [任意]ocrmypdf ──► PDF
```

## プロジェクト構成

```
kindle2pdf/
  config.py        設定（CaptureConfig / Region、JSON保存）
  image_ops.py     画像ヘルパ（縮小比較・差分・余白トリミング）※純粋関数
  stability.py     描画安定＆末尾検知 ※純粋ロジック
  pdf_builder.py   img2pdf でロスレス結合、OCR層付与
  capture.py       mss による高速スクリーンキャプチャ（遅延import）
  page_turn.py     pyautogui によるページ送り（遅延import）
  controller.py    キャプチャループ本体（capture/turn を注入=テスト可能）
  region_picker.py Tk のドラッグ領域選択
  gui.py           Tk コントロールパネル
  cli.py           コマンドライン入口
tests/             純粋コアの単体テスト（表示不要・ヘッドレスで実行可）
```

画面・キーボードに触れる部分（`capture` / `page_turn` / `gui`）は遅延 import に
してあり、精度に関わる中核ロジックはすべてディスプレイなしで単体テストできます。

## テスト

```bash
pip install pytest
pytest -q
```

ダミーのキャプチャ/ページ送りを注入して、キャプチャループ全体（安定検知・
重複除外・末尾検知・PDF生成）をヘッドレスで検証します。

## ライセンス

MIT
