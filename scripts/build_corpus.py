"""reference/full/*.txt から参照コーパス reference/rubric_examples.txt を生成する。

抽出済み全文から管理用テンプレート部分と「解説」セクションを取り除き、
「解答」と「採点基準」を大学・年度のヘッダ付きで連結する。

新しい過去問資料を追加する手順:
1. PDF からテキストを抽出(縦書きは pypdf 推奨。文字順が乱れる場合は採用しない)
2. reference/full/<key>.txt として保存
3. 下の CORPUS_FILES にキーとタイトルを追加
4. python scripts/build_corpus.py を実行
"""

import os
import re

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FULL_DIR = os.path.join(BASE, "reference", "full")
OUT_PATH = os.path.join(BASE, "reference", "rubric_examples.txt")

# コーパスに含めるファイル(抽出品質が確認できたもののみ)。
# 文字順が乱れているもの(tmu2020, tmu_kobun_sanuki, saitama2018_keizai,
# saitama2022_keizai, saitama_unknown_no3)は full/ にのみ保存し、ここには載せない。
CORPUS_FILES = {
    # 東京都立大学
    "tmu2023": "2023年度 東京都立大学 国語(古文『栄花物語』ほか)",
    "tmu2024_q1": "2024年度 東京都立大学 国語 第一問(古文『十訓抄』)",
    "tmu2024_q2": "2024年度 東京都立大学 国語 第二問(現代文 石井美保「都市の縁側」)",
    "tmu2025": "2025年度 東京都立大学 国語(古文『古今堪忍記』ほか)",
    # 奈良女子大学
    "nara2020": "2020年度 奈良女子大学 国語(現代文 保苅実ほか)",
    "nara2021": "2021年度 奈良女子大学 国語(現代文 石井美保ほか)",
    "nara2023": "2023年度 奈良女子大学 国語(現代文 久野愛ほか)",
    "nara2024": "2024年度 奈良女子大学 国語(古文『橿園文集』ほか)",
    "nara2025": "2025年度 奈良女子大学 国語",
    # 埼玉大学
    "saitama2018_kyoiku": "2018年度 埼玉大学 国語(教育学部/現代文 斎藤環ほか)",
    "saitama2019_keizai": "2019年度 埼玉大学 国語(経済学部/現代文 見田宗介ほか)",
    "saitama2020_kyoiku": "2020年度 埼玉大学 国語(教育学部/古典)",
    "saitama2020_sokuho": "2020年度 埼玉大学 国語 解答速報(現代文 大問二・三)",
    "saitama2021_keizai": "2021年度 埼玉大学 国語(経済学部)",
    "saitama2021_kyoiku": "2021年度 埼玉大学 国語(教育学部/古典)",
    "saitama2022_kyoiku": "2022年度 埼玉大学 国語(教育学部)",
    "saitama2023_keizai": "2023年度 埼玉大学 国語(経済学部)",
    "saitama2023_kyoiku": "2023年度 埼玉大学 国語(教育学部/古文)",
    "saitama2024_keizai": "2024年度 埼玉大学 国語(経済学部/現代文 J.ヒックル)",
    "saitama2024_kyoiku": "2024年度 埼玉大学 国語(教育学部/現代文 内田樹ほか)",
    "saitama2025_keizai": "2025年度 埼玉大学 国語(経済学部/現代文 東浩紀ほか)",
    "saitama2025_kyoiku": "2025年度 埼玉大学 国語(教育学部/現代文 東浩紀ほか)",
}

# 「解説」セクションの開始と「採点基準」セクションの開始のマーカー
_KAISETSU_RE = re.compile(r"【解説】|解説\s*問")
_RUBRIC_MARKERS = ("採点基準▼", "【採点基準】")


def strip_admin(t: str) -> str:
    """管理用テンプレート部分を除去(和暦西暦「二〇XX年」タイトル以降を残す)。"""
    m = re.search(r"二〇[一二三四五六七八九〇]{2}年", t)
    return t[m.start():] if m else t


def _next_rubric(t: str, pos: int) -> int:
    hits = [i for m in _RUBRIC_MARKERS if (i := t.find(m, pos)) != -1]
    return min(hits) if hits else -1


def drop_kaisetsu(t: str) -> str:
    """「解説」セクション(〜次の採点基準の直前まで)を除去する。複数大問対応。"""
    result, pos = [], 0
    while True:
        m = _KAISETSU_RE.search(t, pos)
        if not m:
            result.append(t[pos:])
            break
        result.append(t[pos:m.start()])
        j = _next_rubric(t, m.end())
        if j == -1:
            break
        pos = j
    return "".join(result)


def build() -> str:
    parts = []
    for key, title in CORPUS_FILES.items():
        path = os.path.join(FULL_DIR, f"{key}.txt")
        if not os.path.exists(path):
            print(f"SKIP (missing): {key}")
            continue
        t = open(path, encoding="utf-8").read()
        t = strip_admin(t)
        t = drop_kaisetsu(t)
        t = re.sub(r"採点基準例1 列を増やすとき.*?可能です。", "", t)  # テンプレ注記
        t = t.strip()
        parts.append(f"=== {title} ===\n{t}")
        print(f"{key}: {len(t)} chars")
    corpus = "\n\n".join(parts)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(corpus)
    print(f"\nWROTE {OUT_PATH}: {len(corpus)} chars, {len(parts)} exams")
    return corpus


if __name__ == "__main__":
    build()
