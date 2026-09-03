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
import re
import time
from concurrent.futures import ThreadPoolExecutor
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
    _UNIVERSITIES,
    _load_reference,
    resolve_comment,
    select_reference,
)

# コスト重視で sonnet を既定にする(精度重視なら claude-opus-4-8)。
MODEL = "claude-sonnet-5"

# 稼働中コードの版(診断表示用。変更のたびに更新して反映済みか判別できるように)
GRADER_BUILD = "balanced-deduct-5"

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
    for png in pages[:1]:  # ヘッダー(大学名)は先頭ページ上部にある(1枚で判別・低コスト)
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
    unis = "・".join(_UNIVERSITIES)
    content.append(
        {
            "type": "text",
            "text": (
                "この答案用紙のヘッダー印字から、大学名・年度・大問を短く一行で答えてください。\n"
                f"★大学名は必ず次のいずれかです: {unis}。\n"
                "『東進』『東進衛星予備校』『過去問演習講座』などは予備校名・講座名であって"
                "大学名ではありません。これらを大学名として答えないこと。\n"
                "ヘッダーに書かれた実際の大学名(例: 奈良女子大学全学部…)を採用してください。\n"
                "例: 奈良女子大学 2019年度 第2問 / 千葉大学 2018年度 文系 第1問。\n"
                "上記のどの大学にも該当しなければ「不明」とだけ答えてください。"
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
    has_deduct: bool = Field(
        default=False,
        description="減点項目に『＋』ボタンがあり減点リストを展開できる設問か"
        "(True=減点式。採点基準の減点項目と照合して deduct_numbers を出す)",
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
    deduct_numbers: List[int] = Field(
        default_factory=list,
        description="適用する減点項目の番号(採点基準の減点項目に対応する 1,2,3… の番号)。"
        "答案の誤り・不足に該当する減点項目があれば、その番号をすべて列挙する。無ければ空",
    )


class TensakitDecisionResult(BaseModel):
    sections: List[TensakitSectionDecision]


def is_short_answer_section(s: dict) -> bool:
    """短答(漢字書き取り・読み・単語)の小問かどうかを判定する。

    加点項目が1つで、そのラベルが実際の正解語(日本語)になっているもの。
    『+N 配点』(減点式)や『+N 1/2/3』(加点式の要素番号)は短答ではない。
    手書き文字のOCR精度が出ないため、これらはAI採点の対象から外す(手動採点)。
    """
    if s.get("radio_options"):
        return False
    adds = s.get("add_options") or []
    if len(adds) != 1:
        return False
    lab = re.sub(r"^\s*[+＋]?\s*\d+\s*", "", str(adds[0].get("label", ""))).strip()
    if not lab or lab == "配点" or re.fullmatch(r"\d+", lab):
        return False
    return bool(re.search(r"[ぁ-んァ-ヶ一-龥]", lab))


def _hint_from_title(title: str) -> str:
    """Tensakit の画面タイトル(例: 千葉_国語_2_2013_第3問)から
    『大学名 年度 第N問』のヒント文字列を組み立てる。AI判別より正確・無料。

    合致しなければ空文字を返す(呼び出し側でAI判別にフォールバック)。
    """
    if not title:
        return ""
    m_year = re.search(r"(20\d{2})", title)
    m_dai = re.search(r"第\s*([0-9一二三四五六七八九十]+)\s*問", title)
    # 長い略称から先にマッチ(「学芸」より「東京学芸」等)
    aliases = [
        ("東京学芸", "東京学芸大学"), ("学芸", "東京学芸大学"),
        ("東京都立", "東京都立大学"), ("都立", "東京都立大学"),
        ("奈良女子", "奈良女子大学"), ("奈良", "奈良女子大学"),
        ("千葉", "千葉大学"), ("埼玉", "埼玉大学"),
    ]
    uni = ""
    for short, full in aliases:
        if short in title:
            uni = full
            break
    if not (uni and m_year):
        return ""
    dai = f"第{m_dai.group(1)}問" if m_dai else ""
    return f"{uni} {m_year.group(1)}年度 {dai}".strip()


def decide_tensakit_marks(
    page_images: List[bytes],
    sections: List[dict],
    rubric: Optional[str] = None,
    debug_out: Optional[dict] = None,
    exam_title: Optional[str] = None,
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
    # AI混雑(overloaded/429/5xx)時はSDKが自動で待って再試行する
    client = anthropic.Anthropic(max_retries=6)
    pages = list(page_images)[:6]  # 枚数を制限してメモリ・トークンを抑える
    # 出典判別: 画面タイトル(正確・無料)を最優先。無ければAI判別にフォールバック。
    exam_hint = _hint_from_title(exam_title or "")
    if not exam_hint:
        exam_hint = _identify_exam(client, pages) if pages else ""

    # 答案画像(両方の採点パスで共有。末尾にキャッシュ点を置き2回目を安くする)
    img_content: list = []
    for i, png in enumerate(pages):
        img_content.append({"type": "text", "text": f"【答案 {i + 1}/{len(pages)}ページ目】"})
        img_content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png",
                       "data": base64.standard_b64encode(png).decode()},
        })
    if rubric:
        img_content.append({"type": "text", "text": f"【利用者提供の採点基準】(最優先)\n{rubric}"})
    if img_content:
        img_content[-1]["cache_control"] = {"type": "ephemeral"}  # 画像プレフィックスを再利用

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
        # 減点リストは『＋』展開前なので選択肢は取得できないが、減点式かどうかは分かる。
        if s.get("has_deduct") and not s.get("deduct_options"):
            t += ("  ※この設問は減点式です(減点リストは『＋』で展開)。採点基準の減点項目を"
                  "一つずつ答案と照合し、該当する誤り・不足の番号を deduct_numbers に入れること。\n")
        return t

    system_blocks = [{"type": "text", "text": SYSTEM_PROMPT}]
    matched = bool(exam_hint) and exam_hint != "不明"
    reference = select_reference(exam_hint) if matched else ""
    heads = re.findall(r"=== (.*?) ===", reference or "")
    # コスト対策: 特定の試験(数セクション)に絞れた時だけ採点基準を渡す。
    # 判別できず全コーパス(数十セクション・十数万トークン)になる場合は、送っても
    # 該当基準を見つけられず高コストなだけなので渡さない(＝毎回の消費を大幅削減)。
    if not (matched and 1 <= len(heads) <= 4):
        reference = ""
        heads = []
    if debug_out is not None:
        debug_out["exam_hint"] = exam_hint or "(判別なし)"
        debug_out["reference_heads"] = heads[:6]
        debug_out["reference_scope"] = "該当年度に絞込" if reference else "該当基準なし(基準を渡さず採点)"
    if reference:
        system_blocks.append({
            "type": "text",
            "text": "参照実例(採点基準の実例):\n\n" + reference,
            "cache_control": {"type": "ephemeral"},
        })

    # 漢字・単語などの短答は手書き文字のOCR精度が出ず自動採点が機能しないため、
    # AI採点の対象から外す(手動採点)。記述・記号・減点式だけをAIで採点する。
    other_secs = [s for s in sections if not is_short_answer_section(s)]

    main_instr = (
        "以下は東進オンライン採点(Tensakit)の採点パネルの設問です。全セクションを飛ばさず判断すること。\n"
        "★各設問は必ず答案画像の『その設問の実際の記述』を読み取ってから判断すること。"
        "設問番号や配点だけで機械的に満点にしない。答案が採点基準を満たさない箇所は必ず減点する"
        "(答案が違えば結果も変わる)。\n"
        "設問により『加点式』『減点式』『記号選択』のいずれかです。加点項目の内容と採点基準を見て見分けてください。\n"
        "【加点式】加点項目に得点要素が複数ある設問: パネルの加点要素は画面上『番号だけ』"
        "(+2 の横に 1,2,3 等)で内容が書かれていない。採点基準でその設問の得点要素を確認し、"
        "パネルの上から順(1番目→2番目→3番目…)に対応させること。"
        "★採点基準の通し番号(9,10,11 等)ではなく、その設問内の『並び順』で対応させる"
        "(例: 採点基準の問二が 9,10,11 なら、パネルの要素1=9、要素2=10、要素3=11)。\n"
        "  各得点要素の『内容』を採点基準で確認し、答案にその内容が明確に含まれる要素だけを"
        "add_indices(0始まりの位置)で選ぶ。最初の要素へ安易に付けない。2番目・3番目でも"
        "該当すれば必ず選び、該当しない要素は外すこと。\n"
        "【減点式】加点項目が『+N 配点』1つ+減点項目がある設問: まず add_indices に配点(満点=index 0)を入れる。\n"
        "  次に採点基準の各減点項目を1つずつ確認する。手順: (1)採点基準の模範解答と各減点項目を読む"
        "→(2)答案の記述を読み取る→(3)各減点項目ごとに『その要求内容が答案に(表現は違っても)含まれているか』を判定。\n"
        "  ★判定は公平に。要素が『明確に欠けている・明確に誤訳/誤読している』場合だけ、その番号を"
        "deduct_numbers に入れる。以下は減点しない: 部分的にでも要素が表現されている/採点基準が許容する"
        "言い換え・同義・具体例で書かれている(基準の『〜も可』『〜など』を広く認める)/判断に迷う。"
        "無理に減点を増やさない(過剰減点も誤り)。逆に、要素が本当に無いのに満点にもしない。\n"
        "  減点番号は採点基準の減点項目の番号に対応させる。白紙・大きく的外れは加点(index 0)しない。\n"
        "【記号選択】生徒の回答(ア〜ク・未回答等のラジオ): 生徒が書いた記号の index を radio_index に1つ。"
        "記入があるのに『未回答』を選ばない。\n"
        "採点基準に厳密に従い、勝手な加減点はしない。コメントは扱わない。該当が無い項目は空/null。\n\n"
    )
    # 設問が多い大問は1回の思考+出力が max_tokens を超えて途中で切れることがある。
    # 5問ずつに分割し各回の出力を確実に収める(画像・参照実例はプロンプトキャッシュ
    # で再利用されるので分割コストは小)。medium思考でも5問なら上限に収まる。
    CHUNK = 5
    chunks = [other_secs[i:i + CHUNK] for i in range(0, len(other_secs), CHUNK)]

    def _run(chunk):
        # 減点式の減点検出・加点式の要素対応づけには答案と基準の1項目ずつの
        # 照合(=読解)が必要なため effort は medium。low だと減点を検出できず
        # 満点素通りになる。コストは参照実例の絞り込み・タイトル判別(Haiku削減)・
        # max_tokens縮小・並列化で抑える。
        content = img_content + [{"type": "text", "text": main_instr + "\n\n".join(_sec_text(s) for s in chunk)}]
        return _stream_decide(client, system_blocks, content, effort="medium")

    decisions = []
    if len(chunks) <= 1:
        for c in chunks:
            decisions += _run(c)
    else:
        # 複数チャンクは並列実行して待ち時間を短縮(順次だと足し算で遅い)。
        with ThreadPoolExecutor(max_workers=min(3, len(chunks))) as ex:
            for res in ex.map(_run, chunks):
                decisions += res
    return decisions


def _stream_decide(client, system_blocks, content, effort="medium"):
    """1回分の採点判断をストリーミングで実行(混雑時リトライ・途中切れ処理付き)。"""
    for attempt in range(5):
        try:
            with client.with_options(timeout=800.0).messages.stream(
                model=MODEL,
                # 上限。medium思考+5問分割で収まる範囲。32000のような膨張は避ける。
                max_tokens=12000,
                thinking={"type": "adaptive"},
                output_config={"effort": effort},
                system=system_blocks,
                messages=[{"role": "user", "content": content}],
                output_format=TensakitDecisionResult,
            ) as stream:
                response = stream.get_final_message()
            if getattr(response, "stop_reason", None) == "max_tokens":
                raise RuntimeError("採点結果が長すぎて途中で切れました。もう一度お試しください。")
            out = response.parsed_output
            return out.sections if out else []
        except Exception as e:
            msg = str(e).lower()
            retryable = ("overload" in msg or "429" in msg or "rate" in msg
                         or "529" in msg or "503" in msg or "500" in msg)
            if retryable and attempt < 4:
                time.sleep(3 * (2 ** attempt))
                continue
            if "overload" in msg:
                raise RuntimeError("AIが混雑しています。少し待ってからもう一度実行してください。") from e
            if "eof" in msg or "invalid json" in msg or "json_invalid" in msg:
                raise RuntimeError("採点結果が長すぎて途中で切れました。もう一度お試しください。") from e
            raise
    return []
