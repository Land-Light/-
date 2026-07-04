"""国語入試 過去問添削AI — Flask アプリ本体。"""

import io
import uuid

from flask import Flask, abort, render_template, request, send_file

from grader import GENRE_LABELS, GRADER_NAME, QuestionInput, grade_answers
from pdf_generator import build_pdf

app = Flask(__name__)

# 添削結果の一時保存(PDF ダウンロード用)。プロセス内メモリ保持。
_results: dict = {}


@app.route("/")
def index():
    return render_template("index.html", genres=GENRE_LABELS)


def _parse_questions(form) -> list:
    """フォームの配列フィールドから設問リストを組み立てる。"""
    labels = form.getlist("q_label")
    texts = form.getlist("q_text")
    answers = form.getlist("q_answer")
    maxes = form.getlist("q_max")
    models = form.getlist("q_model")
    questions = []
    for i in range(len(answers)):
        text = texts[i].strip() if i < len(texts) else ""
        answer = answers[i].strip()
        if not text and not answer:
            continue  # 空の設問ブロックはスキップ
        try:
            max_score = int(maxes[i]) if i < len(maxes) and maxes[i].strip() else None
        except (ValueError, IndexError):
            max_score = None
        label = labels[i].strip() if i < len(labels) and labels[i].strip() else f"問{i + 1}"
        model = models[i].strip() if i < len(models) else ""
        questions.append(
            QuestionInput(
                label=label,
                question=text,
                answer=answer,
                max_score=max_score,
                model_answer=model or None,
            )
        )
    return questions


@app.route("/grade", methods=["POST"])
def grade():
    genre = request.form.get("genre", "hyoron")
    passage = request.form.get("passage", "").strip() or None
    rubric = request.form.get("rubric", "").strip() or None
    target_university = request.form.get("target_university", "").strip() or None

    questions = _parse_questions(request.form)
    invalid = [q for q in questions if not q.answer]
    if not questions or invalid:
        return render_template(
            "index.html", genres=GENRE_LABELS,
            error="各設問には少なくとも「答案」を入力してください(設問文があると出典判別の精度が上がります)。",
            form=request.form,
        ), 400

    try:
        result = grade_answers(
            genre=genre,
            questions=questions,
            passage=passage,
            rubric=rubric,
            target_university=target_university,
        )
    except Exception as e:  # API エラー等はユーザーに提示
        return render_template(
            "index.html", genres=GENRE_LABELS,
            error=f"添削中にエラーが発生しました: {e}", form=request.form,
        ), 502

    result_id = uuid.uuid4().hex
    _results[result_id] = {
        "result": result,
        "genre_label": GENRE_LABELS.get(genre, genre),
        "questions": questions,
    }

    return render_template(
        "result.html",
        result=result,
        result_id=result_id,
        genre_label=GENRE_LABELS.get(genre, genre),
        questions=questions,
        grader_name=GRADER_NAME,
    )


@app.route("/pdf/<result_id>")
def download_pdf(result_id: str):
    data = _results.get(result_id)
    if data is None:
        abort(404)
    pdf_bytes = build_pdf(data["result"], data["genre_label"], data["questions"])
    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype="application/pdf",
        as_attachment=True,
        download_name="添削結果.pdf",
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
