# 国語 過去問添削AI

大学入試国語(現代文・古文・漢文・小論文)の過去問答案を Claude が添削・採点し、
講評コメント付きの結果を Web 画面と **PDF** で返却するアプリです。
予備校の過去問演習講座(解答・解説・採点基準)の添削形式に倣っています。

## 機能

- **設問ごとの一括添削** — 大問1つ分(問一〜問六など)の設問・答案をまとめて送信
- **減点法採点** — 予備校の採点基準と同じ「『〜』という内容がなければ○点減点」形式で、
  設問ごとに減点内訳を明示
- **採点基準の指定** — 赤本・過去問演習講座の採点基準を貼り付けると、それに厳密に従って採点
- **赤ペン講評** — 設問ごとの講評/満点相当の書き直し例/総評/良かった点・改善点/学習アドバイス
- **PDF出力** — 添削結果レポートをワンクリックでPDFダウンロード(日本語フォント埋め込み)

## セットアップ

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...   # Anthropic API キー
python app.py
```

ブラウザで http://localhost:5000 を開いてください。

### PDF の日本語フォント

`pdf_generator.py` が以下の順で日本語 TTF を自動検出して PDF に埋め込みます。

1. リポジトリ同梱 `fonts/ipaexm.ttf` / `fonts/ipaexg.ttf`(任意で配置)
2. システムフォント(IPAex / IPA / Takao / Noto CJK)
3. 見つからない場合は ReportLab 内蔵 CID フォントにフォールバック(Acrobat 系ビューア以外では表示できない場合があります)

Debian/Ubuntu なら `apt install fonts-ipafont` でインストールできます。

## 構成

| ファイル | 役割 |
|---|---|
| `app.py` | Flask アプリ(フォーム受付・結果表示・PDFダウンロード) |
| `grader.py` | Claude API 呼び出し(構造化出力で設問別・減点法の採点結果を取得) |
| `pdf_generator.py` | ReportLab による添削結果PDFの生成 |
| `templates/` | 入力フォーム・結果画面のテンプレート |

## 技術メモ

- モデルは `claude-opus-4-8`(adaptive thinking 有効)を使用
- 採点結果は Structured Outputs(`client.messages.parse` + Pydantic)で JSON スキーマを保証
- システムプロンプトに prompt cache(ephemeral)を設定済み
- 添削結果はプロセス内メモリに一時保存(PDF ダウンロード用)。再起動で消えます
