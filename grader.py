"""国語入試答案の添削・採点を行う Claude API 呼び出しモジュール。

予備校の過去問演習講座(解答・解説・採点基準)の形式に倣い、
設問ごとに減点法で採点し、減点内訳と赤ペン講評を返す。
"""

import os
from functools import lru_cache
from typing import List, Optional

import anthropic
from pydantic import BaseModel, Field

MODEL = "claude-opus-4-8"

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

SYSTEM_PROMPT = """あなたは日本の大学入試国語(現代文・古文・漢文・小論文)の過去問添削指導に長年携わってきたベテラン採点者です。
予備校の過去問演習講座と同じ流儀で、受験生の答案を厳密かつ建設的に添削してください。

採点の方針(重要):
- 各設問は「減点法」で採点する。まず満点解答に必要な要素を列挙し、欠落・誤りごとに
  「『〜』という内容がなければ○点減点」の形式で減点する。減点の合計が満点を超える場合、その設問は0点とする。
- 採点基準が与えられている場合は、その基準に厳密に従うこと。自分の基準で上書きしない。
- 採点基準がない場合は、本文・設問・模範解答から自分で採点基準(必要要素と減点幅)を構成して適用する。
- 現代語訳では文法事項(助動詞の意味・敬語・句法など)の訳出漏れを減点対象として明示する。
- 記述説明問題では「設問要求への対応(文末表現含む)」「本文根拠」「必要要素の網羅」「字数・表現」を確認する。
- 理由説明問題で文末が理由の形(〜から。〜ため。)になっていなければ減点する。

講評の方針:
- 答案の余白に赤ペンで書き込む講評のように、「どこが」「なぜ」減点かを具体的に指摘する。
- 本文の該当箇所(段落・表現)を根拠として示す。
- 受験生本人に語りかける文体で、良い点を認めた上で、次に何をすべきかを明確に伝える。
- 各設問に満点相当の書き直し例を必ず示す。
- 誤字・脱字・不自然な日本語も指摘する。"""


class Deduction(BaseModel):
    """減点内訳の1項目。"""

    points: int = Field(description="減点数(正の整数。例: 2点減点なら 2)")
    reason: str = Field(
        description="減点理由。「『〜』という内容がないため」など採点基準の形式で具体的に"
    )


class QuestionGrading(BaseModel):
    """設問1つ分の採点結果。"""

    label: str = Field(description="設問番号(例: 問一、問二(1))")
    score: int = Field(description="この設問の得点(満点−減点合計。0未満なら0)")
    max_score: int = Field(description="この設問の配点")
    deductions: List[Deduction] = Field(description="減点内訳。満点なら空リスト")
    comment: str = Field(description="この設問への赤ペン講評(良い点・減点箇所の具体的指摘)")
    rewrite_example: str = Field(description="満点相当の解答例(書き直し例)")


class GradingResult(BaseModel):
    """添削結果全体。"""

    total_score: int = Field(description="合計得点")
    max_score: int = Field(description="配点合計")
    grade_label: str = Field(description="評価(例: A / B / C / 合格圏 / 要努力)")
    questions: List[QuestionGrading] = Field(description="設問ごとの採点結果")
    overall_comment: str = Field(description="答案全体への総評(受験生への語りかけ)")
    strengths: List[str] = Field(description="良かった点の箇条書き")
    improvements: List[str] = Field(description="改善すべき点の箇条書き(具体的に)")
    study_advice: str = Field(description="今後の学習アドバイス")


class QuestionInput(BaseModel):
    """フォームから受け取る設問1つ分の入力。"""

    label: str
    question: str
    answer: str
    max_score: int
    model_answer: Optional[str] = None


GENRE_LABELS = {
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

    genre_label = GENRE_LABELS.get(genre, genre)
    total = sum(q.max_score for q in questions)
    parts = [f"【ジャンル】{genre_label}", f"【配点合計】{total}点"]
    if target_university:
        parts.append(f"【志望校・レベル】{target_university}")
    if passage:
        parts.append(f"【本文(問題文)】\n{passage}")
    if rubric:
        parts.append(
            f"【採点基準】(この基準に厳密に従って採点すること)\n{rubric}"
        )

    for q in questions:
        block = [f"◆{q.label}(配点{q.max_score}点)", f"設問: {q.question}"]
        if q.model_answer:
            block.append(f"模範解答: {q.model_answer}")
        block.append(f"受験生の答案: {q.answer}")
        parts.append("\n".join(block))

    parts.append(
        "上記の答案を設問ごとに減点法で添削・採点してください。"
        "各設問の得点は配点から減点合計を引いた値(0未満は0)とし、"
        "合計得点は各設問の得点の和と一致させてください。"
    )

    system_blocks = [{"type": "text", "text": SYSTEM_PROMPT}]
    reference = _load_reference()
    if reference:
        system_blocks.append(
            {
                "type": "text",
                "text": (
                    "以下は、実際の予備校の過去問演習講座で使われている"
                    "「解答・採点基準」の実例です。減点項目の立て方"
                    "(「『〜』という内容がなければ○点減点」「＊〜も許容」など)、"
                    "許容解答の示し方、要素ごとの配点の粒度を、この実例と同じ"
                    "厳密さ・形式で運用してください。また、受験生が提出した設問が"
                    "実例中の過去問と一致する場合は、該当する採点基準に厳密に"
                    "従って採点してください。\n\n" + reference
                ),
            }
        )
    # 最後のブロックに cache_control を置き、system 全体をキャッシュする
    system_blocks[-1]["cache_control"] = {"type": "ephemeral"}

    response = client.messages.parse(
        model=MODEL,
        max_tokens=16000,
        thinking={"type": "adaptive"},
        system=system_blocks,
        messages=[{"role": "user", "content": "\n\n".join(parts)}],
        output_format=GradingResult,
    )

    if response.stop_reason == "refusal":
        raise RuntimeError("採点リクエストが安全上の理由で処理できませんでした。入力内容をご確認ください。")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("採点結果が長すぎて途中で切れました。設問数を減らして再度お試しください。")

    result = response.parsed_output
    if result is None:
        raise RuntimeError("採点結果の解析に失敗しました。もう一度お試しください。")
    return result
