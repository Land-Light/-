"""添削結果を PDF に出力するモジュール(ReportLab / 日本語フォント埋め込み)。

予備校の過去問演習講座の添削返却レポートに倣ったレイアウト:
得点サマリー → 設問別採点(減点内訳・講評・書き直し例) → 総評・学習アドバイス。
"""

import glob
import io
import os
from datetime import datetime, timedelta, timezone
from typing import List

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable,
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from grader import GradingResult, QuestionInput

# _register_fonts() が実際に使えるフォント名で上書きする
GOTHIC = "JPGothic"
MINCHO = "JPMincho"

JST = timezone(timedelta(hours=9))

ACCENT = colors.HexColor("#1a3a6e")
RED = colors.HexColor("#c0392b")
LIGHT_BG = colors.HexColor("#eef2f8")
RED_BG = colors.HexColor("#fdf3f2")

# 日本語 TTF の探索候補(リポジトリ同梱 → システムフォントの順)
_FONT_CANDIDATES = {
    "JPMincho": [
        "fonts/ipaexm.ttf",
        "/usr/share/fonts/opentype/ipaexfont-mincho/ipaexm.ttf",
        "/usr/share/fonts/opentype/ipafont-mincho/ipam.ttf",
        "/usr/share/fonts/truetype/fonts-japanese-mincho.ttf",
        "/usr/share/fonts/truetype/takao-mincho/TakaoMincho.ttf",
    ],
    "JPGothic": [
        "fonts/ipaexg.ttf",
        "/usr/share/fonts/opentype/ipaexfont-gothic/ipaexg.ttf",
        "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
        "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
        "/usr/share/fonts/truetype/takao-gothic/TakaoGothic.ttf",
    ],
}

_registered = False


def _find_ttf(candidates: list) -> str:
    base = os.path.dirname(os.path.abspath(__file__))
    for path in candidates:
        full = path if os.path.isabs(path) else os.path.join(base, path)
        if os.path.exists(full):
            return full
    for pattern in (
        "/usr/share/fonts/**/NotoSansCJK*.ttf",
        "/usr/share/fonts/**/NotoSansJP*.ttf",
    ):
        hits = glob.glob(pattern, recursive=True)
        if hits:
            return hits[0]
    return ""


def _register_fonts() -> None:
    """埋め込み可能な日本語 TTF を探して登録する。

    TTF はフォントを PDF に埋め込むためどのビューアでも表示できる。
    見つからない場合のみ Acrobat 系ビューア依存の CID フォントに
    フォールバックする。
    """
    global GOTHIC, MINCHO, _registered
    if _registered:
        return

    resolved = {}
    for logical, candidates in _FONT_CANDIDATES.items():
        path = _find_ttf(candidates)
        if path:
            pdfmetrics.registerFont(TTFont(logical, path))
            resolved[logical] = logical

    if resolved:
        MINCHO = resolved.get("JPMincho", resolved.get("JPGothic"))
        GOTHIC = resolved.get("JPGothic", resolved.get("JPMincho"))
    else:
        pdfmetrics.registerFont(UnicodeCIDFont("HeiseiMin-W3"))
        pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
        MINCHO = "HeiseiMin-W3"
        GOTHIC = "HeiseiKakuGo-W5"
    _registered = True


def _styles():
    return {
        "title": ParagraphStyle(
            "title", fontName=GOTHIC, fontSize=17, leading=23,
            alignment=TA_CENTER, textColor=ACCENT, spaceAfter=4,
        ),
        "meta": ParagraphStyle(
            "meta", fontName=MINCHO, fontSize=9, leading=13,
            alignment=TA_CENTER, textColor=colors.HexColor("#555555"),
        ),
        "heading": ParagraphStyle(
            "heading", fontName=GOTHIC, fontSize=12, leading=17,
            textColor=ACCENT, spaceBefore=11, spaceAfter=5,
        ),
        "qheading": ParagraphStyle(
            "qheading", fontName=GOTHIC, fontSize=11.5, leading=16,
            textColor=colors.white, spaceBefore=0, spaceAfter=0,
        ),
        "body": ParagraphStyle(
            "body", fontName=MINCHO, fontSize=10, leading=16.5,
        ),
        "small_label": ParagraphStyle(
            "small_label", fontName=GOTHIC, fontSize=9.5, leading=14,
            textColor=ACCENT, spaceBefore=5, spaceAfter=2,
        ),
        "deduction": ParagraphStyle(
            "deduction", fontName=MINCHO, fontSize=9.5, leading=15,
            textColor=RED,
        ),
        "score": ParagraphStyle(
            "score", fontName=GOTHIC, fontSize=25, leading=31,
            alignment=TA_CENTER, textColor=RED,
        ),
        "quote": ParagraphStyle(
            "quote", fontName=MINCHO, fontSize=9.5, leading=15.5,
            leftIndent=5 * mm, textColor=colors.HexColor("#333333"),
        ),
        "cell": ParagraphStyle(
            "cell", fontName=MINCHO, fontSize=9.5, leading=14.5,
        ),
    }


def _esc(text: str) -> str:
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\n", "<br/>")
    )


def build_pdf(
    result: GradingResult,
    genre_label: str,
    questions: List[QuestionInput],
) -> bytes:
    """添削結果 PDF のバイト列を生成する。"""
    _register_fonts()
    st = _styles()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=16 * mm, bottomMargin=16 * mm,
        title="国語 過去問添削 結果レポート",
    )
    answers = {q.label: q for q in questions}
    story = []

    story.append(Paragraph("国語 過去問添削 結果レポート", st["title"]))
    now = datetime.now(JST).strftime("%Y年%m月%d日 %H:%M")
    story.append(Paragraph(f"ジャンル:{_esc(genre_label)} / 添削日時:{now}", st["meta"]))
    story.append(Spacer(1, 3 * mm))
    story.append(HRFlowable(width="100%", thickness=1.2, color=ACCENT))
    story.append(Spacer(1, 4 * mm))

    # 得点サマリー
    per_q = " ".join(f"{q.label} {q.score}/{q.max_score}" for q in result.questions)
    score_table = Table(
        [[
            Paragraph(
                f"{result.total_score} <font size=12 color='#555555'>/ {result.max_score} 点</font>",
                st["score"],
            ),
            Paragraph(
                f"評価:{_esc(result.grade_label)}<br/><font size=9 color='#555555'>{_esc(per_q)}</font>",
                st["heading"],
            ),
        ]],
        colWidths=[62 * mm, 112 * mm],
    )
    score_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), LIGHT_BG),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BOX", (0, 0), (-1, -1), 0.8, ACCENT),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(score_table)
    story.append(Spacer(1, 3 * mm))

    # 設問別
    for q in result.questions:
        block = []
        head = Table(
            [[
                Paragraph(f"{_esc(q.label)}", st["qheading"]),
                Paragraph(
                    f"<font color='white'>得点 {q.score} / {q.max_score} 点</font>",
                    st["qheading"],
                ),
            ]],
            colWidths=[120 * mm, 54 * mm],
        )
        head.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), ACCENT),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("ALIGN", (1, 0), (1, 0), "RIGHT"),
        ]))
        block.append(head)
        block.append(Spacer(1, 2 * mm))

        qin = answers.get(q.label)
        if qin:
            block.append(Paragraph("設問", st["small_label"]))
            block.append(Paragraph(_esc(qin.question), st["quote"]))
            block.append(Paragraph("提出答案", st["small_label"]))
            block.append(Paragraph(_esc(qin.answer), st["quote"]))

        # 減点内訳
        block.append(Paragraph("減点内訳", st["small_label"]))
        if q.deductions:
            rows = [
                [
                    Paragraph(f"−{d.points}点", st["deduction"]),
                    Paragraph(_esc(d.reason), st["deduction"]),
                ]
                for d in q.deductions
            ]
            ded = Table(rows, colWidths=[18 * mm, 156 * mm])
            ded.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), RED_BG),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e0b4ae")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]))
            block.append(ded)
        else:
            block.append(Paragraph("減点なし(満点)", st["body"]))

        block.append(Paragraph("講評", st["small_label"]))
        block.append(Paragraph(_esc(q.comment), st["body"]))
        block.append(Paragraph("書き直し例(満点解答例)", st["small_label"]))
        block.append(Paragraph(_esc(q.rewrite_example), st["quote"]))
        block.append(Spacer(1, 4 * mm))
        story.append(KeepTogether(block))

    # 総評
    story.append(HRFlowable(width="100%", thickness=0.8, color=ACCENT))
    story.append(Paragraph("■ 総評", st["heading"]))
    story.append(Paragraph(_esc(result.overall_comment), st["body"]))

    story.append(Paragraph("■ 良かった点", st["heading"]))
    for s in result.strengths:
        story.append(Paragraph(f"・{_esc(s)}", st["body"]))

    story.append(Paragraph("■ 改善すべき点", st["heading"]))
    for s in result.improvements:
        story.append(Paragraph(f"・{_esc(s)}", st["body"]))

    story.append(Paragraph("■ 今後の学習アドバイス", st["heading"]))
    story.append(Paragraph(_esc(result.study_advice), st["body"]))

    doc.build(story)
    return buf.getvalue()
