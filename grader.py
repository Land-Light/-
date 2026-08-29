"""国語入試答案の添削・採点を行う Claude API 呼び出しモジュール。

フロー:
1. 提出された設問・答案から、どの大学・年度・大問の過去問かを判別する
2. 参照コーパス(過去問演習講座の解答・採点基準)から該当の採点基準を探す
3. 見つかればその基準に厳密に従って採点する(加点法・減点法・併用など、
   基準が定める方式のまま)。見つからなければ同じ形式で基準を自作して採点する
4. 採点者名は「佐藤」で固定
"""

import os
import re
from functools import lru_cache
from typing import List, Literal, Optional

import anthropic
from pydantic import BaseModel, Field

# 採点用モデル。コスト重視で sonnet を既定にする(精度重視なら claude-opus-4-8)。
MODEL = "claude-sonnet-5"
# 出典判別(大学・年度の判定)用の安価なモデル。
IDENTIFY_MODEL = "claude-haiku-4-5"

GRADER_NAME = "佐藤"

# 参照コーパスに含まれる大学(フル名 → 略称も許容)
_UNIVERSITIES = ["東京都立大学", "奈良女子大学", "埼玉大学", "千葉大学", "東京学芸大学"]

# よくある指摘の定型講評(使い回し)。AIはコードだけ返し、本文はここから展開する。
# → 出力トークンを節約してコストを下げる。すべて丁寧語(です・ます調)。
COMMENT_TEMPLATES = {
    "KANJI": "漢字の誤りです。とめ・はね・画数まで正確に書きましょう。",
    "OKURI": "送り仮名が誤っています。正しい送り方を確認しましょう。",
    "KEYWORD": "設問が求める指定語句・要素が入っていません。",
    "SHORT": "方向性は合っていますが、必要な内容が不足しています。",
    "OVER": "指定字数を超えています。要素を圧縮しましょう。",
    "UNDER": "指定字数に足りません。要素を補いましょう。",
    "OFF": "本文の趣旨とずれています。該当箇所を読み直しましょう。",
    "KUHOU": "句法の理解に誤りがあります。頻出句法を確認しましょう。",
    "GOGI": "古語・語句の語義を取り違えています。",
    "BLANK": "無答です。部分点を狙って一部でも書きましょう。",
    "NIHONGO": "日本語表現が不自然です。文を整えましょう。",
}


def resolve_comment(code: Optional[str], free_text: Optional[str]) -> str:
    """自由記述があればそれを、無ければ定型講評コードを本文に展開して返す。"""
    if free_text and free_text.strip():
        return free_text.strip()
    if code:
        return COMMENT_TEMPLATES.get(code.strip().upper(), "")
    return ""

_REFERENCE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "reference", "rubric_examples.txt"
)


@lru_cache(maxsize=1)
def _load_reference() -> str:
    """実際の過去問演習講座の解答・採点基準の実例(参照コーパス)を読み込む。"""
    try:
        with open(_REFERENCE_PATH, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


@lru_cache(maxsize=1)
def _reference_sections():
    """コーパスを `=== 年度 大学名 … ===` 見出しごとのセクションに分割する。

    返り値: [(header, section_text), ...]
    """
    text = _load_reference()
    if not text:
        return ()
    parts = re.split(r"(?m)^(=== .*? ===)\s*$", text)
    sections = []
    # parts = [preamble, header1, body1, header2, body2, ...]
    for i in range(1, len(parts) - 1, 2):
        header = parts[i].strip()
        body = parts[i + 1].strip()
        sections.append((header, header + "\n" + body))
    return tuple(sections)


def select_reference(hint: Optional[str]) -> str:
    """出典ヒント(大学名・年度等)に合致する採点基準セクションだけを返す。

    ・大学が判別でき、年度も合致 → その年度のセクションだけ(最小)
    ・大学のみ判別 → その大学の全セクション
    ・判別できない/曖昧 → 全コーパス(安全側。誤った基準で採点しない)
    """
    sections = _reference_sections()
    if not sections:
        return ""
    if not hint:
        return _load_reference()

    # 大学を判別(フル名・略称の両方を許容)
    uni = None
    for u in _UNIVERSITIES:
        short = u.replace("大学", "大")
        if u in hint or short in hint or (u == "東京都立大学" and "都立" in hint):
            uni = u
            break
    if uni is None:
        return _load_reference()  # 大学不明 → 全体(安全側)

    short = uni.replace("大学", "大")
    uni_secs = [(h, b) for (h, b) in sections if uni in h or short in h]
    if not uni_secs:
        return _load_reference()

    # 年度が合致すればさらに絞り込む
    m = re.search(r"(20\d{2})", hint or "")
    if m:
        yr_secs = [(h, b) for (h, b) in uni_secs if m.group(1) in h]
        if yr_secs:
            uni_secs = yr_secs

    return "\n\n".join(b for (_, b) in uni_secs)


SYSTEM_PROMPT = """あなたは日本の大学入試国語(現代文・古文・漢文・小論文)の過去問添削指導に長年携わってきたベテラン採点者「佐藤」です。
予備校の過去問演習講座の採点者として、受験生の答案を厳密かつ建設的に添削してください。

必ず次の手順で採点すること:
1. 【出典の判別】提出された設問・答案・本文を、後述の参照実例(過去問の解答・採点基準)と照合し、
   どの大学・年度・大問の問題かを判別する。判別結果(大学名・年度・大問・出典作品)を必ず報告する。
   判別できない場合は「判別できず」と報告する。
2. 【採点基準の選択】参照実例に該当の採点基準がある場合は、その基準に厳密に従って採点する。
   基準が加点法なら加点法、減点法なら減点法、併用なら併用のまま運用し、自分の基準で上書きしない。
   利用者が採点基準を貼り付けた場合は、それを最優先で適用する。
   どちらも無い場合のみ、参照実例と同じ形式・粒度(「『〜』という内容がなければ○点減点」
   「Ｘという内容(○点)」「＊〜も許容」)で採点基準を自作して適用する。
3. 【採点】各設問について、適用した基準の項目ごとに加点・減点を判定し、内訳をすべて明示する。
   0点以下になった場合、その問は0点とする。誤字脱字以外の部分点は基準に無い限り認めない。
4. 【講評】答案の余白に赤ペンで書き込むように、「どこが」「なぜ」加点・減点なのかを、
   本文の該当箇所を根拠に具体的に指摘する。良い点を認めた上で次に何をすべきかを明確に伝える。
   各設問に満点相当の書き直し例を必ず示す。誤字・脱字・不自然な日本語も指摘する。
   ★文体は必ず丁寧語(です・ます調)で統一すること。設問別の講評(comment)・書き直し例の
   説明・総評(overall_comment)・欄外講評(margin_comment)を含め、すべての記述を
   です・ます調で書く。断定・命令口調(「〜せよ」「〜すべき」)や体言止めの多用は避け、
   「〜しましょう」「〜が必要です」「〜すると得点が伸びます」のように丁寧に述べる。
5. 【設問の粒度】内容の異なる小問(問二(1)(2)のように別々に説明・記述する小問)は、
   小問ごとに独立した採点項目(questions の1項目)として扱う。
   一方、漢字書き取り・記号選択・抜き出しのように「多数の小問を○×で集計する設問」(問一 ア〜コ 等)は、
   設問全体(問一)を1つの採点項目とし、score はその合計点とする。各小問の正誤は書き込み(マーク)で示す。
   漢字問題・記号問題には講評コメントを付けない(マークと合計点だけ)。
6. 【答案への書き込み記号】答案に直接書き込む(または書き込み位置を指示する)場合の記号は
   次で統一する: 正解=○、部分点=△、誤答・指摘箇所=✔(チェック)。✗(バツ)は用いない。
   記号は必ず得点と整合させること: 満点=○、0点=✔、それ以外の部分点=△。
   満点の答案に✔を付けるなどの不整合は不可。
   すべての設問(小問を含む)に必ずいずれかの記号を付け、マーク漏れを作らないこと。
7. 【総評】総評(overall_comment)は設問別講評とは書き方を変え、次の規則に従うこと:
   - 受験生の氏名や呼びかけは入れない。
   - 励まし・慰め・感想などの主観的な内容は書かない。
   - 「どういう点を意識すると最も得点が伸びるか」を、採点基準と失点の内訳に即して
     客観的・具体的に書く(例: 設問の要求要素の分解、根拠箇所の特定、句法・語彙の暗記、
     指定字数への要素の圧縮など、答案から判明した失点原因に直結する着眼点)。
   - 文体は丁寧語(です・ます調)とする(客観的な内容を丁寧に述べる)。"""


class ScoreAdjustment(BaseModel):
    """加点・減点の内訳1項目。"""

    kind: Literal["加点", "減点"] = Field(description="加点か減点か")
    points: int = Field(description="点数(正の整数)")
    reason: str = Field(
        description="判定理由。適用した採点基準の項目(「『〜』という内容がないため」等)を明記"
    )


class QuestionGrading(BaseModel):
    """設問1つ分の採点結果。"""

    label: str = Field(description="設問番号(例: 問一、問二(1))")
    score: int = Field(description="この設問の得点(0未満なら0)")
    max_score: int = Field(description="この設問の配点")
    applied_rubric: str = Field(
        description="適用した採点基準の出典(例: 2024年度 東京都立大学 第一問 問四の採点基準 / 利用者提供の採点基準 / 自作基準)"
    )
    adjustments: List[ScoreAdjustment] = Field(
        description="加点・減点の内訳。加点法の基準なら獲得した要素を加点として列挙する"
    )
    comment: str = Field(description="この設問への赤ペン講評(良い点・失点箇所の具体的指摘)")
    rewrite_example: str = Field(description="満点相当の解答例(書き直し例)")


class GradingResult(BaseModel):
    """添削結果全体。"""

    matched_exam: str = Field(
        description="判別した出典(例: 2024年度 東京都立大学 国語 第一問〈古文『十訓抄』〉)。判別できない場合は「判別できず」"
    )
    grading_method: str = Field(
        description="適用した採点方式(例: 減点法 / 加点法・減点法併用 / 利用者提供基準)"
    )
    total_score: int = Field(description="合計得点")
    max_score: int = Field(description="配点合計")
    grade_label: str = Field(description="評価(例: A / B / C / 合格圏 / 要努力)")
    questions: List[QuestionGrading] = Field(description="設問ごとの採点結果")
    overall_comment: str = Field(
        description=(
            "答案全体への総評。氏名・呼びかけ・励ましなどの主観的内容は書かない。"
            "どの点を意識すれば最も得点が伸びるかを、採点基準と失点内訳に即して客観的・具体的に書く"
        )
    )
    strengths: List[str] = Field(description="良かった点の箇条書き")
    improvements: List[str] = Field(description="改善すべき点の箇条書き(具体的に)")
    study_advice: str = Field(description="今後の学習アドバイス")


class QuestionInput(BaseModel):
    """フォームから受け取る設問1つ分の入力。"""

    label: str
    question: str = ""
    answer: str
    max_score: Optional[int] = None
    model_answer: Optional[str] = None


GENRE_LABELS = {
    "auto": "自動判別",
    "hyoron": "現代文(評論)",
    "shosetsu": "現代文(小説)",
    "kobun": "古文",
    "kanbun": "漢文",
    "shoronbun": "小論文",
}


def grade_answers(
    genre: str,
    questions: List[QuestionInput],
    passage: Optional[str] = None,
    rubric: Optional[str] = None,
    target_university: Optional[str] = None,
) -> GradingResult:
    """答案一式を添削・採点して構造化された結果を返す。"""
    client = anthropic.Anthropic()

    parts = []
    genre_label = GENRE_LABELS.get(genre, genre)
    if genre != "auto":
        parts.append(f"【ジャンル】{genre_label}")
    if target_university:
        parts.append(f"【志望校・レベル】{target_university}")
    if passage:
        parts.append(f"【本文(問題文)】\n{passage}")
    if rubric:
        parts.append(f"【利用者提供の採点基準】(最優先で適用すること)\n{rubric}")

    for q in questions:
        block = [f"◆{q.label}" + (f"(配点{q.max_score}点)" if q.max_score else "(配点は基準から判断)")]
        if q.question:
            block.append(f"設問: {q.question}")
        if q.model_answer:
            block.append(f"模範解答: {q.model_answer}")
        block.append(f"受験生の答案: {q.answer}")
        parts.append("\n".join(block))

    parts.append(
        "上記の答案について、まず出典(大学・年度・大問)を判別し、"
        "該当する採点基準を選んで、その基準が定める方式のまま採点してください。"
        "配点が入力されていない設問は、判別した採点基準の配点を用いてください。"
        "合計得点は各設問の得点の和と一致させてください。"
    )

    system_blocks = [{"type": "text", "text": SYSTEM_PROMPT}]
    # 出典ヒント(志望校・本文・設問文)から採点基準を絞り込む(コスト削減)
    hint = " ".join(
        filter(None, [target_university, (passage or "")[:800]]
               + [q.question for q in questions])
    )
    reference = select_reference(hint)
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
    # 最後のブロックに cache_control を置き、system 全体をキャッシュする
    system_blocks[-1]["cache_control"] = {"type": "ephemeral"}

    # max_tokens が大きいため、非ストリーミングだと SDK の10分ガードで弾かれる。
    # ストリーミングで受信し完成メッセージを取得する。
    with client.with_options(timeout=800.0).messages.stream(
        model=MODEL,
        max_tokens=32000,
        thinking={"type": "adaptive"},
        output_config={"effort": "medium"},  # 思考量を抑え高速化・低コスト化
        system=system_blocks,
        messages=[{"role": "user", "content": "\n\n".join(parts)}],
        output_format=GradingResult,
    ) as stream:
        response = stream.get_final_message()

    if response.stop_reason == "refusal":
        raise RuntimeError("採点リクエストが安全上の理由で処理できませんでした。入力内容をご確認ください。")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("採点結果が長すぎて途中で切れました。設問数を減らして再度お試しください。")

    result = response.parsed_output
    if result is None:
        raise RuntimeError("採点結果の解析に失敗しました。もう一度お試しください。")
    return result
