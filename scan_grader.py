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
    IDENTIFY_MODEL,
    GradingResult,
    QuestionInput,
    SYSTEM_PROMPT,
    _load_reference,
    resolve_comment,
    select_reference,
)

# コスト重視で sonnet を既定にする(精度重視なら claude-opus-4-8)。
MODEL = "claude-sonnet-5"

_RENDER_SCALE = 2.0  # 手書き判読用に高めの解像度で描画する


class MarkPos(BaseModel):
    """書き込み位置。ページ左上(0,0)〜右下(1,1)の割合。"""

    page: int = Field(description="1始まりのページ番号")
    x: float = Field(description="左端からの割合 0〜1")
    y: float = Field(description="上端からの割合 0〜1")


class ItemMark(BaseModel):
    """漢字書き取り・記号選択など、小問集合の各小問に付ける正誤マーク。"""

    pos: MarkPos = Field(description="その小問の解答欄上の記号位置")
    correct: bool = Field(description="正解なら true(○)、不正解なら false(✔)")


class CreditMark(BaseModel):
    """加点した該当箇所を「くの字」の括弧で囲む位置。"""

    pos: MarkPos = Field(description="囲む範囲の中心位置(加点対象の語句・要素の中央)")
    width: float = Field(
        default=0.05, description="囲む範囲の横幅(ページ幅に対する割合)。縦書きなら細めでよい"
    )
    height: float = Field(
        default=0.08,
        description="囲む範囲の縦の長さ(ページ高さに対する割合)。縦書きで複数字にわたる加点箇所は大きめにする",
    )


class QuestionAnnotation(BaseModel):
    """設問1つ分の書き込み位置と欄外講評。"""

    label: str = Field(description="設問番号(例: 問一)。採点結果の label と一致させる")
    score_pos: MarkPos = Field(
        description="この設問の得点(漢字・記号の集合設問なら合計点)を1つだけ書く位置(設問番号ラベルの真上の余白)"
    )
    symbol_pos: Optional[MarkPos] = Field(
        default=None,
        description="記述・内容問題で記号(○/△/✔)を1つ置く位置。漢字・記号の集合設問では使わず item_marks を使う",
    )
    item_marks: List[ItemMark] = Field(
        default_factory=list,
        description="漢字書き取り・記号選択など、小問を多数○×で採点する設問の各小問マーク位置と正誤。"
        "これを使う設問では symbol_pos は不要。通常の記述問題では空にする",
    )
    comment_code: Optional[str] = Field(
        default=None,
        description="定型講評コード。機械的な指摘(KANJI/OKURI/BLANK/OVER/UNDER/NIHONGO)のみに使う。"
        "記述・内容問題では使わず margin_comment に具体的に書くこと",
    )
    margin_comment: str = Field(
        default="",
        description="欄外に赤ペンで書く講評(縦書き)。記述・内容問題では必ずここに、"
        "欠けている指定語句・要素を名指しし、どう直せば得点になるかを1〜2文(40〜80字)で具体的に書く。"
        "抽象的な決まり文句だけは不可。正解の設問は空にする",
    )
    comment_pos: Optional[MarkPos] = Field(
        default=None,
        description="欄外講評の書き出し位置(答案記入欄のすぐ左の余白の上端)。講評が無ければ省略",
    )
    credit_marks: List[CreditMark] = Field(
        default_factory=list,
        description="加点法で得点を与えた該当箇所を「くの字」括弧で囲む位置。"
        "加点した要素・語句ごとに1つずつ指定する(参考資料の採点例と同じ流儀)。"
        "加点が無い設問、および漢字・記号の集合設問では空にする",
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

【設問タイプ別の書き込み】
(A) 漢字書き取り・記号選択・抜き出しなど「小問を多数○×で採点する設問」(問一 ア〜コ 等):
  questions では設問全体(問一)を1項目にまとめ、score は合計点にする。
  annotations では score_pos に合計点を1つだけ書き、item_marks に各小問の位置と正誤(correct)を列挙する。
  各小問には○(正解)/✔(不正解)が打たれる。この種の設問には得点数字を小問ごとに書かない。
  ★漢字問題・記号問題には講評(margin_comment・comment_code)を一切付けない(空にする)。
(B) 内容の異なる記述小問(問二(1)(2)など、別々に説明する小問):小問ごとに questions・annotations を分け、
  それぞれ symbol_pos に記号を1つ、必要なら具体的な margin_comment を書く。

【加点箇所の囲み(くの字)】採点基準が加点法(要素ごとに点を与える方式)の場合は、
参考資料の採点例と同じように、加点した該当箇所を答案上で「くの字」の括弧で囲むこと。
annotations の credit_marks に、加点した要素・語句ごとに囲む位置(pos)と範囲(width・height)を
指定する。答案は縦書きが多いので、複数字にわたる要素は height を大きめにして縦方向に囲む。
加点が無い設問や、漢字・記号の集合設問(A)では credit_marks は空にする。

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
- total_score_pos: 答案全体の合計得点を書く位置。答案用紙の「得点」欄(枠)を画像から探し、
  その枠の内側中央の座標を指定する。「得点」欄は多くの場合、最終ページの左下や表紙の枠にある。
  QRコードや生徒番号・余白など、得点欄以外の場所には絶対に置かないこと。合計は必ずこの枠内に1つだけ書く。
- grader_pos: 「採点者」「担当」等の欄(枠)があれば、その枠の内側中央の座標を指定する。
  枠からずれないよう、枠の位置を画像から正確に読み取ること(佐藤 と印字される)。
- overall_comment_pos: 最終ページの大きな空白スペース(答案記入欄・罫線・QRコードと重ならない場所)の
  右上端を指定する。ここに総評(overall_comment)が縦書きで印字される。縦書きは指定位置から下に
  1文字ずつ、約30字で左の列に折り返すため、総評の長さに見合った幅の余白を選ぶこと。
- questions に含めた全設問(小問含む)について、annotations にも必ず対応する項目を作ること(マーク漏れ禁止)。

【講評の方針(具体性を優先しつつ出力を節約)】
- 正解(満点)の設問には欄外講評を付けない(margin_comment も comment_code も空)。○マークだけで足りる。
- 定型コード(comment_code)は「機械的で説明の要らない指摘」だけに使う:
  KANJI(漢字誤り)/OKURI(送り仮名)/BLANK(白紙・無答)/OVER(字数超過)/UNDER(字数不足)/NIHONGO(不自然な日本語)。
  例えば漢字書き取りの誤りは KANJI コードだけでよい。
- 記述・説明・要約・内容読解などの問題(現代文・古文・漢文の記述設問)は、定型コードを使わず
  必ず margin_comment に「具体的に」書く。次を必ず含めること:
    ・何が欠けて/誤って失点したか(指定語句・要素を名指し。例「指定語『視線』が使われていません」
      「『個人所蔵の否定』の要素が抜けています」「主語の取り違えです」)
    ・本文のどこを踏まえるべきか、どう直せば得点になるか(端的に)
  「内容が不足しています」「趣旨がずれています」のような、どの答案にも当てはまる抽象的な文だけで
  済ませてはならない。その答案・その設問に固有の指摘を1〜2文(40〜80字)で書くこと。
  (KEYWORD/SHORT/OFF/KUHOU/GOGI のコードは、具体的に書けないときの最終手段に留める。)
- BLANK(無答)は解答欄が白紙・未記入のときだけ。記入があり不正解の場合は自由記述で理由を書く。
- strengths・improvements・study_advice は空(空配列・空文字)にする。書き込みPDFでは使用しない。
- rewrite_example(書き直し例)は誤答・部分点の設問だけ記載し、正解の設問は空にする。
- transcriptions は採点に必要な範囲で簡潔に。長い答案を一字一句すべて写す必要はない。"""


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


def _identify_exam(client, pages: List[bytes]) -> str:
    """答案の先頭ページから大学名・年度・大問を安価なモデルで判別する。

    採点基準コーパスを絞り込むためのヒント文字列を返す(失敗時は空文字)。
    """
    content: list = []
    for png in pages[:2]:  # ヘッダーは先頭ページにある
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
    content.append(
        {
            "type": "text",
            "text": (
                "この答案用紙のヘッダーや印字から、大学名・年度・大問(学部が分かれば学部も)を"
                "短く一行で答えてください。例: 千葉大学 2018年度 文系 第1問。"
                "判別できなければ「不明」とだけ答えてください。"
            ),
        }
    )
    try:
        resp = client.messages.create(
            model=IDENTIFY_MODEL,
            max_tokens=100,
            messages=[{"role": "user", "content": content}],
        )
        return "".join(b.text for b in resp.content if b.type == "text").strip()
    except Exception:
        return ""


def grade_scanned_pdf(
    pdf_bytes: bytes,
    rubric: Optional[str] = None,
) -> ScanGradingResult:
    """スキャン答案PDFを判読・採点し、書き込み位置付きの結果を返す。"""
    client = anthropic.Anthropic()

    pages = render_pages_png(pdf_bytes)
    # 二段階参照: まず出典を判別し、該当する採点基準だけを読み込む(コスト削減)
    exam_hint = _identify_exam(client, pages)
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
    # 判別できた出典で採点基準を絞り込む(判別不能なら全コーパスに自動フォールバック)
    reference = select_reference(exam_hint) if exam_hint and exam_hint != "不明" else _load_reference()
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
            output_config={"effort": "medium"},  # 思考量を抑え高速化・低コスト化
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
        # 設問上の得点(集合設問なら合計点)を1つ書く
        marks.append(
            Mark(page=a.score_pos.page, x=a.score_pos.x, y=a.score_pos.y,
                 kind="text", text=str(q.score), size=22)
        )

        # 加点した該当箇所を「くの字」括弧で囲む(参考資料の採点例に準拠)
        for cm in a.credit_marks:
            marks.append(
                Mark(page=cm.pos.page, x=cm.pos.x, y=cm.pos.y,
                     kind="kuno", width=cm.width, height=cm.height)
            )

        if a.item_marks:
            # 漢字・記号などの集合設問: 各小問に○(正解)/✔(不正解)を打つ。コメントは付けない。
            for im in a.item_marks:
                if im.correct:
                    marks.append(Mark(page=im.pos.page, x=im.pos.x, y=im.pos.y,
                                      kind="circle", width=0.05, height=0.09))
                else:
                    marks.append(Mark(page=im.pos.page, x=im.pos.x, y=im.pos.y,
                                      kind="check", size=15))
            continue  # 集合設問には欄外講評を付けない

        # 通常設問: 得点に応じた記号(○/△/✔)を1つ
        if a.symbol_pos:
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
        # 欄外の縦書き講評(自由記述が無ければ定型講評コードを展開して使う)
        margin = resolve_comment(a.comment_code, a.margin_comment)
        if margin and a.comment_pos:
            marks.append(
                Mark(page=a.comment_pos.page, x=a.comment_pos.x, y=a.comment_pos.y,
                     kind="vtext", text=margin, size=8.2, max_rows=30)
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


# ── Tensakit(東進オンライン採点)への自動入力判断 ────────────────────────
# Tensakit の採点パネルは、設問ごとに「加点項目」「減点項目」のチェックボックス
# (採点基準そのもの)を並べている。採点をやり直すのではなく、実際に画面に出て
# いる選択肢を読み取り、答案に照らして「どの項目にチェックを入れるか」だけを
# AI に判断させる。これにより基準とのズレを防ぎ、入力を確実にする。

class TensakitPanelOption(BaseModel):
    """採点パネルの1選択肢(加点/減点のチェック項目)。"""

    index: int = Field(description="そのセクション内での選択肢の通し番号(0始まり)")
    label: str = Field(description="画面に表示されている選択肢の文言(例: +2 1, とむら(う) など)")


class TensakitSectionInput(BaseModel):
    """採点パネルの1セクション(設問・小問)分の入力候補。"""

    section_label: str = Field(description="セクション見出し(例: 第一問 / 一 / コ)")
    add_options: List[TensakitPanelOption] = Field(default_factory=list, description="加点項目の選択肢")
    deduct_options: List[TensakitPanelOption] = Field(default_factory=list, description="減点項目の選択肢")
    radio_options: List[TensakitPanelOption] = Field(
        default_factory=list, description="記号選択(生徒の回答: A〜H・未回答)のラジオ選択肢"
    )


class TensakitSectionDecision(BaseModel):
    """1セクションについて、チェックすべき加点/減点項目(コメントは扱わない)。"""

    section_label: str = Field(description="対象セクション見出し(入力の section_label と一致させる)")
    add_indices: List[int] = Field(
        default_factory=list, description="チェックする加点項目の index(該当が無ければ空)"
    )
    deduct_indices: List[int] = Field(
        default_factory=list, description="チェックする減点項目の index(該当が無ければ空)"
    )
    radio_index: Optional[int] = Field(
        default=None,
        description="記号選択問題で、生徒が解答した記号のラジオ選択肢 index を1つだけ選ぶ。"
        "空欄・無記入なら『未回答』の index。記号問題でなければ null",
    )


class TensakitDecisionResult(BaseModel):
    sections: List[TensakitSectionDecision]


def decide_tensakit_marks(
    page_images: List[bytes],
    sections: List[dict],
    rubric: Optional[str] = None,
) -> List[TensakitSectionDecision]:
    """Tensakit 採点パネルの選択肢を、答案に照らしてどう選ぶか判断する。

    page_images: 答案ページのPNGバイト列(Tensakit画面のスクショ、または
                 PDFを描画した画像)。呼び出し側で用意する(メモリ節約のため
                 この関数内ではPDF描画をしない)。
    sections: [{"section_label":..., "add_options":[{"index","label"},...],
                "deduct_options":[...]}...] (画面から読み取ったもの)
    戻り値: セクションごとの選択(add_indices/deduct_indices)。
    """
    if not sections:
        return []
    client = anthropic.Anthropic()
    pages = list(page_images)[:6]  # 枚数を制限してメモリ・トークンを抑える
    exam_hint = _identify_exam(client, pages) if pages else ""

    content: list = []
    for i, png in enumerate(pages):
        content.append({"type": "text", "text": f"【答案 {i + 1}/{len(pages)}ページ目】"})
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png",
                       "data": base64.standard_b64encode(png).decode()},
        })
    if rubric:
        content.append({"type": "text", "text": f"【利用者提供の採点基準】(最優先)\n{rubric}"})

    def _sec_text(s):
        t = "■セクション: " + s["section_label"] + "\n"
        if s.get("add_options"):
            t += "  加点項目:\n" + "".join(
                f"    [{o['index']}] {o['label']}\n" for o in s["add_options"])
        if s.get("deduct_options"):
            t += "  減点項目:\n" + "".join(
                f"    [{o['index']}] {o['label']}\n" for o in s["deduct_options"])
        if s.get("radio_options"):
            t += "  記号選択(生徒の回答):\n" + "".join(
                f"    [{o['index']}] {o['label']}\n" for o in s["radio_options"])
        return t

    panel_text = "\n\n".join(_sec_text(s) for s in sections)
    content.append({
        "type": "text",
        "text": (
            "以下は東進オンライン採点(Tensakit)の採点パネルに実際に表示されている、"
            "設問ごとの選択肢です。上の答案を読み、各セクションについて次を判断してください。\n"
            "・加点項目/減点項目(チェックボックス)がある設問: 該当する項目の index を "
            "add_indices/deduct_indices に入れる(採点基準そのものなので勝手な加点減点はしない)。\n"
            "・記号選択(生徒の回答: A〜H・未回答 等のラジオ)がある設問: 生徒が実際に解答した"
            "記号の選択肢 index を radio_index に1つだけ入れる。空欄・無記入なら『未回答』の index。\n"
            "コメントは扱いません(選択のみ)。該当が無い項目は空/ null のまま返すこと。\n\n"
            + panel_text
        ),
    })

    system_blocks = [{"type": "text", "text": SYSTEM_PROMPT}]
    reference = select_reference(exam_hint) if exam_hint and exam_hint != "不明" else _load_reference()
    if reference:
        system_blocks.append({
            "type": "text",
            "text": "参照実例(採点基準の実例):\n\n" + reference,
            "cache_control": {"type": "ephemeral"},
        })

    # コメント生成をしない分、出力は短い。max_tokens を抑えて低コスト・低メモリに。
    with client.with_options(timeout=800.0).messages.stream(
        model=MODEL,
        max_tokens=6000,
        thinking={"type": "adaptive"},
        output_config={"effort": "medium"},
        system=system_blocks,
        messages=[{"role": "user", "content": content}],
        output_format=TensakitDecisionResult,
    ) as stream:
        response = stream.get_final_message()
    out = response.parsed_output
    return out.sections if out else []
