"""スキャン答案PDFに赤ペン添削を直接書き込むモジュール。

ReportLab で赤ペンのオーバーレイページを描画し、pypdf で元PDFに合成する。
完全にローカルで動作し、API を必要としない。

座標系: ページ左上を (0, 0)、右下を (1, 1) とする割合指定。

採点記号の規約(本プロジェクト共通ルール):
- 正解         → ○ (circle)
- 部分点       → △ (tri)
- 誤答・指摘箇所 → ✔ (check)
- ✗ (cross) は原則使用しない(kind としては残すが、通常の採点では使わないこと)
- どの設問にも必ず何らかの記号を付ける(マーク漏れを作らない)
判定から記号を選ぶときは mark_kind_for() を使う。
"""

import io
from typing import List, Literal, Optional

from pypdf import PdfReader, PdfWriter
from pydantic import BaseModel, Field
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas as rl_canvas

from pdf_generator import GOTHIC, _register_fonts

RED = HexColor("#d0342c")

# 判定 → 記号の対応(採点記号の規約)
JUDGEMENT_KINDS = {
    "正解": "circle",
    "部分点": "tri",
    "誤答": "check",
    "指摘": "check",
}


def mark_kind_for(judgement: str) -> str:
    """判定(正解/部分点/誤答/指摘)から規約どおりの記号 kind を返す。"""
    return JUDGEMENT_KINDS.get(judgement, "check")


def mark_kind_for_score(score: int, max_score: int) -> str:
    """得点から規約どおりの記号 kind を返す(記号と得点の不整合を防ぐ)。

    満点=○(circle)、0点=✔(check)、それ以外の部分点=△(tri)。
    """
    if score >= max_score:
        return "circle"
    if score <= 0:
        return "check"
    return "tri"


class Mark(BaseModel):
    """赤ペン書き込み1つ分。

    kind:
      text   — 横書きテキスト(得点数字・記号など)
      vtext  — 縦書きテキスト(欄外コメント。右→左に折り返す)
      circle — 楕円(正解の○)
      check  — チェックマーク(✓)
      cross  — バツ(✗)
      tri    — 三角(△: 部分点)
      line   — 傍線(縦線。記述の指摘箇所)
      kuno   — くの字括弧(加点した該当箇所を囲む。width×height の範囲)
    """

    page: int = Field(description="1始まりのページ番号")
    x: float = Field(description="左端からの割合 0〜1")
    y: float = Field(description="上端からの割合 0〜1")
    kind: Literal["text", "vtext", "circle", "check", "cross", "tri", "line"] = "text"
    text: str = ""
    size: float = 11.0
    width: float = 0.03  # circle/line 用(ページ幅に対する割合)
    height: float = 0.04  # circle/line 用(ページ高さに対する割合)
    max_rows: int = 26  # vtext の1列あたり最大文字数
    col_gap: Optional[float] = None  # vtext の列間隔(pt)。省略時は size*1.35


def _draw_vtext(c, mark: Mark, W: float, H: float) -> None:
    """縦書きテキスト。(x, y) を右上端として下に文字を積み、列は左へ折り返す。"""
    size = mark.size
    gap = mark.col_gap if mark.col_gap else size * 1.35
    c.setFont(GOTHIC, size)
    col, row = 0, 0
    for ch in mark.text:
        if ch == "\n" or row >= mark.max_rows:
            col, row = col + 1, 0
            if ch == "\n":
                continue
        x = W * mark.x - col * gap
        y = H * (1 - mark.y) - (row + 1) * size * 1.12
        # 長音・ダッシュは縦書きで回転させる
        if ch in "ー−―〜":
            c.saveState()
            c.translate(x + size / 2, y + size / 2)
            c.rotate(-90)
            c.drawCentredString(0, -size / 3, ch)
            c.restoreState()
        else:
            c.drawString(x, y, ch)
        row += 1


def _draw_mark(c, mark: Mark, W: float, H: float) -> None:
    c.setStrokeColor(RED)
    c.setFillColor(RED)
    c.setLineWidth(1.6)
    x, y = W * mark.x, H * (1 - mark.y)

    if mark.kind == "text":
        c.setFont(GOTHIC, mark.size)
        c.drawString(x, y, mark.text)
    elif mark.kind == "vtext":
        _draw_vtext(c, mark, W, H)
    elif mark.kind == "circle":
        w, h = W * mark.width, H * mark.height
        c.ellipse(x - w / 2, y - h / 2, x + w / 2, y + h / 2, stroke=1, fill=0)
    elif mark.kind == "check":
        s = mark.size
        p = c.beginPath()
        p.moveTo(x - s * 0.5, y)
        p.lineTo(x - s * 0.1, y - s * 0.45)
        p.lineTo(x + s * 0.7, y + s * 0.55)
        c.drawPath(p)
    elif mark.kind == "cross":
        s = mark.size * 0.55
        c.line(x - s, y - s, x + s, y + s)
        c.line(x - s, y + s, x + s, y - s)
    elif mark.kind == "tri":
        s = mark.size * 0.7
        p = c.beginPath()
        p.moveTo(x, y + s)
        p.lineTo(x - s * 0.9, y - s * 0.7)
        p.lineTo(x + s * 0.9, y - s * 0.7)
        p.close()
        c.drawPath(p)
    elif mark.kind == "line":
        c.setLineWidth(2.2)
        c.line(x, y, x, y - H * mark.height)
    elif mark.kind == "kuno":
        # 加点箇所を囲む「くの字」括弧。(x, y) を中心に、width×height の範囲を
        # 対角のかぎ括弧(「 と 」)で囲う。縦書き答案では height を大きめにする。
        c.setLineWidth(2.0)
        w = W * mark.width
        h = H * mark.height
        tw = max(w * 0.5, 6)   # かぎの横棒の長さ
        th = max(h * 0.18, 8)  # かぎの縦棒の長さ
        left, right = x - w / 2, x + w / 2
        top, bot = y + h / 2, y - h / 2
        # 上のかぎ括弧(左上): 上辺を右へ・左端を下へ
        c.line(left, top, left + tw, top)
        c.line(left, top, left, top - th)
        # 下のかぎ括弧(右下): 下辺を左へ・右端を上へ
        c.line(right, bot, right - tw, bot)
        c.line(right, bot, right, bot + th)


def annotate_pdf(src_pdf: bytes, marks: List[Mark]) -> bytes:
    """元のスキャンPDFに赤ペン書き込みを合成したPDFを返す。"""
    _register_fonts()
    reader = PdfReader(io.BytesIO(src_pdf))
    writer = PdfWriter()

    by_page = {}
    for m in marks:
        by_page.setdefault(m.page, []).append(m)

    for i, page in enumerate(reader.pages):
        page_marks = by_page.get(i + 1, [])
        if page_marks:
            W = float(page.mediabox.width)
            H = float(page.mediabox.height)
            buf = io.BytesIO()
            c = rl_canvas.Canvas(buf, pagesize=(W, H))
            for m in page_marks:
                _draw_mark(c, m, W, H)
            c.save()
            buf.seek(0)
            overlay = PdfReader(buf).pages[0]
            page.merge_page(overlay)
        writer.add_page(page)

    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()
