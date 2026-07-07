"""スキャン答案PDF(複数可)を自動採点するモジュール。

フロー(1ファイルあたり):
1. PDF の各ページを画像化して Claude に渡す
2. Claude が手書き答案を判読し、出典を判別、該当の採点基準で採点
3. 併せて「答案に直接書き込む」ための位置情報(得点・記号・欄外講評)を生成
4. annotator.py でオーバーレイ合成し、書き込み済みPDFを作る

記号は mark_kind_for_score() で得点から機械的に決めるため、
「満点なのに✔」のような不整合は構造的に発生しない。
"""

import base64
import io
from typing import List, Optional

import anthropic
from pydantic import BaseModel, Field

from annotator import Mark, annotate_pdf, mark_kind_for_score
from grader import (
    GRADER_NAME,
    GradingResult,
    QuestionInput,
    SYSTEM_PROMPT,
    _load_reference,
)

MODEL = "claude-opus-4-8"

_RENDER_SCALE = 2.0  # 手書き判読用に高めの解像度で描画する


class MarkPos(BaseModel):
    """書き込み位置。ページ左上(0,0)〜右下(1,1)の割合。"""

    page: int = Field(description="1始まりのページ番号")
    x: float = Field(description="左端からの割合 0〜1")
    y: float = Field(description="上端からの割合 0〜1")


class QuestionAnnotation(BaseModel):
    """設問1つ分の書き込み位置と欄外講評。"""

    label: str = Field(description="設問番号(例: 問一)。採点結果の label と一致させる")
    score_pos: MarkPos = Field(description="得点数字を書く位置(設問番号ラベルの真上の余白)")
    symbol_pos: MarkPos = Field(description="記号(○/△/✔)を書く位置(答案記入欄の中央付近)")
    margin_comment: str = Field(
        description="欄外に赤ペンで書く短い講評(30〜90字。縦書きで印字される)"
    )
    comment_pos: Optional[MarkPos] = Field(
        default=None,
        description="欄外講評の書き出し位置(答案記入欄のすぐ左の余白の上端)。余白が無ければ省略",
    )


class ScanGradingResult(GradingResult):
    """スキャン答案の採点結果(判読テキストと書き込み位置付き)。"""

    student_name: str = Field(default="", description="答案から読み取った氏名(無ければ空)")
    student_id: str = Field(default="", description="答案から読み取った生徒番号等(無ければ空)")
    transcriptions: List[QuestionInput] = Field(
        description="判読した答案の転記(設問ごと)。判読に自信がない箇所は answer 中に「(?)」を付す"
    )
    annotations: List[QuestionAnnotation] = Field(
        description="設問ごとの書き込み位置。questions の全 label 分を必ず含める"
    )
    total_score_pos: Optional[MarkPos] = Field(
        default=None, description="答案の「得点」欄の枠内の位置(あれば)"
    )
    grader_pos: Optional[MarkPos] = Field(
        default=None, description="答案の「採点者」欄の枠内の位置(あれば)"
    )
    overall_comment_pos: Optional[MarkPos] = Field(
        default=None,
        description="総評を書き込む位置。最終ページの大きな余白(答案記入欄・枠と重ならない場所)の右上端を指定する",
    )


SCAN_INSTRUCTIONS = """答案はスキャン画像で与えられます。追加の手順:

【判読】手書き文字を丁寧に判読し、設問ごとに transcriptions へ転記すること。
崩し字などで判読に自信がない文字は「(?)」を付す。誤記と思われる字はそのまま転記し、講評で指摘する。

【小問ごとのマーク】問一(1)(2)や問二アイウのように小問がある設問は、小問ごとに
transcriptions・questions・annotations をそれぞれ分けて作り、各小問に得点・記号・講評を付ける。
「問一」を1つにまとめてはならない。小問の数だけマークを作ること。

【書き込み位置の指定】各設問(小問含む)について、答案画像に赤ペンで書き込むための位置を
annotations に指定すること。座標は各ページ画像の左上を(0,0)、右下を(1,1)とする割合。
位置は必ず実際の画像を見て、対象の設問・解答・欄の座標を正確に読み取って決めること。
- score_pos: その設問(小問)の解答が書かれた行の右端付近の余白、または設問番号ラベルの
  真上の余白。得点数字を書く。他の設問の得点や記号と重ならないようにする。
- symbol_pos: その設問(小問)の解答が実際に書かれている位置の中央〜末尾付近。○/△/✔記号を書く
  (記号の種類はシステムが得点から決める)。必ずその小問の解答欄の上に来るようにし、
  隣の設問の欄にはみ出さないこと。
- comment_pos: その設問の解答欄のすぐ左(または直近)の余白の上端。margin_comment が縦書きで印字される。
  下方向に1文字ずつ、左方向に折り返して印字されるため、記入欄・罫線と重ならない余白を選ぶ。
- total_score_pos: 答案用紙に「得点」欄(枠)があれば、その枠の内側中央の座標を指定する。
- grader_pos: 「採点者」「担当」等の欄(枠)があれば、その枠の内側中央の座標を指定する。
  枠からずれないよう、枠の位置を画像から正確に読み取ること(佐藤 と印字される)。
- overall_comment_pos: 最終ページの大きな空白スペース(答案記入欄・罫線・QRコードと重ならない場所)の
  右上端を指定する。ここに総評(overall_comment)が縦書きで印字される。縦書きは指定位置から下に
  1文字ずつ、約30字で左の列に折り返すため、総評の長さに見合った幅の余白を選ぶこと。
- questions に含めた全設問(小問含む)について、annotations にも必ず対応する項目を作ること(マーク漏れ禁止)。"""


def render_pages_png(pdf_bytes: bytes, scale: float = _RENDER_SCALE) -> List[bytes]:
    """PDF の各ページを PNG 画像に描画する。"""
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(io.BytesIO(pdf_bytes))
    images = []
    for page in doc:
        pil = page.render(scale=scale).to_pil()
        buf = io.BytesIO()
        pil.save(buf, format="PNG")
        images.append(buf.getvalue())
    return images


def grade_scanned_pdf(
    pdf_bytes: bytes,
    rubric: Optional[str] = None,
) -> ScanGradingResult:
    """スキャン答案PDFを判読・採点し、書き込み位置付きの結果を返す。"""
    client = anthropic.Anthropic()

    pages = render_pages_png(pdf_bytes)
    content = []
    for i, png in enumerate(pages):
        content.append({"type": "text", "text": f"【答案 {i + 1}/{len(pages)}ページ目】"})
        content.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": base64.standard_b64encode(png).decode(),
                },
            }
        )
    if rubric:
        content.append(
            {"type": "text", "text": f"【利用者提供の採点基準】(最優先で適用すること)\n{rubric}"}
        )
    content.append(
        {
            "type": "text",
            "text": (
                "上記のスキャン答案を判読し、出典(大学・年度・大問)を判別のうえ、"
                "該当する採点基準に沿って採点してください。"
                "書き込み位置(annotations)も全設問分を必ず指定してください。"
            ),
        }
    )

    system_blocks = [{"type": "text", "text": SYSTEM_PROMPT + "\n\n" + SCAN_INSTRUCTIONS}]
    reference = _load_reference()
    if reference:
        system_blocks.append(
            {
                "type": "text",
                "text": (
                    "以下は、実際の予備校の過去問演習講座で使われている"
                    "「解答・採点基準」の実例(参照実例)です。出典判別と"
                    "採点基準の選択・運用は、必ずこの実例に基づいて行ってください。\n\n"
                    + reference
                ),
            }
        )
    system_blocks[-1]["cache_control"] = {"type": "ephemeral"}

    try:
        # max_tokens が大きい(思考+長い出力)ため、非ストリーミングだと SDK の
        # 10分ガードで弾かれる。ストリーミングで受信し完成メッセージを取得する。
        with client.with_options(timeout=800.0).messages.stream(
            model=MODEL,
            max_tokens=32000,
            thinking={"type": "adaptive"},
            system=system_blocks,
            messages=[{"role": "user", "content": content}],
            output_format=ScanGradingResult,
        ) as stream:
            response = stream.get_final_message()
    except Exception as e:
        # 出力途中切れ等でJSON解析に失敗した場合の分かりやすいメッセージ
        if "json" in str(e).lower() or "EOF" in str(e) or "validation error" in str(e).lower():
            raise RuntimeError(
                "採点結果が長すぎて途中で切れました。1回のアップロード枚数を減らしてお試しください。"
            ) from e
        raise

    if response.stop_reason == "refusal":
        raise RuntimeError("採点リクエストが安全上の理由で処理できませんでした。")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("採点結果が長すぎて途中で切れました。")

    result = response.parsed_output
    if result is None:
        raise RuntimeError("採点結果の解析に失敗しました。")
    return result


def build_marks(result: ScanGradingResult) -> List[Mark]:
    """採点結果と書き込み位置から赤ペンマーク一式を組み立てる。

    記号は得点から mark_kind_for_score() で決定するため、
    得点と記号の不整合(満点に✔等)は発生しない。
    """
    marks: List[Mark] = []
    scores = {q.label: q for q in result.questions}

    for a in result.annotations:
        q = scores.get(a.label)
        if q is None:
            continue
        # 設問上の得点
        marks.append(
            Mark(page=a.score_pos.page, x=a.score_pos.x, y=a.score_pos.y,
                 kind="text", text=str(q.score), size=22)
        )
        # 得点に応じた記号(○/△/✔)
        kind = mark_kind_for_score(q.score, q.max_score)
        if kind == "circle":
            marks.append(
                Mark(page=a.symbol_pos.page, x=a.symbol_pos.x, y=a.symbol_pos.y,
                     kind="circle", width=0.05, height=0.09)
            )
        else:
            marks.append(
                Mark(page=a.symbol_pos.page, x=a.symbol_pos.x, y=a.symbol_pos.y,
                     kind=kind, size=15)
            )
        # 欄外の縦書き講評
        if a.margin_comment and a.comment_pos:
            marks.append(
                Mark(page=a.comment_pos.page, x=a.comment_pos.x, y=a.comment_pos.y,
                     kind="vtext", text=a.margin_comment, size=8.2, max_rows=30)
            )

    if result.total_score_pos:
        p = result.total_score_pos
        marks.append(Mark(page=p.page, x=p.x, y=p.y, kind="text",
                          text=str(result.total_score), size=20))
    if result.grader_pos:
        p = result.grader_pos
        marks.append(Mark(page=p.page, x=p.x, y=p.y, kind="text",
                          text=GRADER_NAME, size=11))

    # 総評を最終ページの余白に縦書きで書き込む
    if result.overall_comment:
        if result.overall_comment_pos:
            p = result.overall_comment_pos
            page, x, y = p.page, p.x, p.y
        else:
            # フォールバック: 記号を打った最終ページの中央左寄り
            page = max((a.symbol_pos.page for a in result.annotations), default=1)
            x, y = 0.50, 0.15
        marks.append(Mark(page=page, x=x, y=y, kind="vtext",
                          text=result.overall_comment,
                          size=9.5, max_rows=30))
    return marks


def grade_and_annotate(pdf_bytes: bytes, rubric: Optional[str] = None):
    """採点して(採点結果, 書き込み済みPDFバイト列)を返す。"""
    result = grade_scanned_pdf(pdf_bytes, rubric=rubric)
    annotated = annotate_pdf(pdf_bytes, build_marks(result))
    return result, annotated
