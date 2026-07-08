"""国語入試 過去問添削AI — Flask アプリ本体。"""

import concurrent.futures
import io
import os
import uuid

from flask import Flask, Response, abort, render_template, request, send_file

from annotator import Mark, annotate_pdf
from grader import GENRE_LABELS, GRADER_NAME, QuestionInput, grade_answers
from pdf_generator import build_pdf
from scan_grader import build_marks, grade_scanned_pdf, render_pages_png
from toshin_fetcher import ToshinFetchError, fetch_answers

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 256 * 1024 * 1024  # アップロード上限 256MB(大量枚数対応)

# 一括採点の並列数。答案採点はAPI待ちが大半なので並列化で総時間を短縮できる。
# メモリ(無料枠512MB)とAPIレート制限を考慮した既定値。環境変数で調整可。
GRADE_CONCURRENCY = max(1, int(os.environ.get("GRADE_CONCURRENCY", "3")))

# 添削結果の一時保存(PDF ダウンロード用)。プロセス内メモリ保持。
_results: dict = {}


def _grade_batch(items: list, rubric):
    """items(=[{filename, pdf_bytes, source_meta?}, ...])を並列採点し、
    結果を _results に保存して batch(表示用リスト)を返す。順序は維持する。"""
    batch = [None] * len(items)

    def _one(idx: int, item: dict):
        entry = {"filename": item["filename"]}
        pdf_bytes = item.get("pdf_bytes")
        if not pdf_bytes:
            entry.update({"ok": False, "error": item.get("error", "ダウンロード失敗")})
            return idx, entry
        try:
            result = grade_scanned_pdf(pdf_bytes, rubric=rubric)
            marks = build_marks(result)
            result_id = uuid.uuid4().hex
            _results[result_id] = {
                "result": result,
                "genre_label": GENRE_LABELS.get("auto", "自動判別"),
                "questions": result.transcriptions,
                "pdf_bytes": pdf_bytes,
                "marks": [m.model_dump() for m in marks],  # 編集可能な書き込み位置
                "filename": item["filename"],
                "source_meta": item.get("source_meta"),
            }
            entry.update({"ok": True, "result_id": result_id, "result": result})
        except Exception as e:  # 1枚の失敗で全体を止めない
            entry.update({"ok": False, "error": str(e)})
        return idx, entry

    workers = min(GRADE_CONCURRENCY, max(1, len(items)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(_one, i, it) for i, it in enumerate(items)]
        for fut in concurrent.futures.as_completed(futures):
            idx, entry = fut.result()
            batch[idx] = entry

    batch_id = uuid.uuid4().hex
    _results[f"batch:{batch_id}"] = [e.get("result_id") for e in batch if e and e.get("ok")]
    return batch, batch_id

# 公開デプロイ時の簡易認証。環境変数 APP_PASSWORD を設定すると
# Basic 認証(ユーザー名は任意、パスワード一致)が全ページに掛かる。
_APP_PASSWORD = os.environ.get("APP_PASSWORD", "")


@app.before_request
def _require_password():
    # ヘルスチェック用エンドポイントは認証を掛けない
    # (掛けると Render 等の死活監視が 401 で失敗し、サービスが Live にならない)
    if request.path == "/healthz":
        return None
    if not _APP_PASSWORD:
        return None  # 未設定ならローカル利用とみなし認証なし
    auth = request.authorization
    if auth and auth.password == _APP_PASSWORD:
        return None
    return Response(
        "認証が必要です", 401,
        {"WWW-Authenticate": 'Basic realm="kokugo-tensaku"'},
    )


@app.route("/healthz")
def healthz():
    """死活監視用。認証不要で 200 を返す(Render のヘルスチェック用)。"""
    return "ok", 200


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


@app.route("/grade-scans", methods=["POST"])
def grade_scans():
    """スキャン答案PDF(複数可)を一括採点する。"""
    files = [f for f in request.files.getlist("scans") if f and f.filename]
    rubric = request.form.get("scan_rubric", "").strip() or None
    if not files:
        return render_template(
            "index.html", genres=GENRE_LABELS,
            error="答案PDFを1つ以上選択してください。", form=request.form,
        ), 400

    items = [{"filename": f.filename, "pdf_bytes": f.read()} for f in files]
    batch, batch_id = _grade_batch(items, rubric)
    return render_template(
        "scans_result.html", batch=batch, batch_id=batch_id, grader_name=GRADER_NAME,
    )


@app.route("/fetch-toshin", methods=["POST"])
def fetch_toshin():
    """東進添削システムから答案を自動取得して一括採点する。"""
    rubric = request.form.get("toshin_rubric", "").strip() or None
    try:
        max_count = int(request.form.get("toshin_max", "10"))
    except ValueError:
        max_count = 10

    try:
        answers = fetch_answers(max_count=max_count)
    except ToshinFetchError as e:
        return render_template(
            "index.html", genres=GENRE_LABELS,
            error=f"東進からの取得に失敗しました: {e}", form=request.form,
        ), 502

    items = [
        {"filename": a.filename, "pdf_bytes": a.pdf_bytes,
         "source_meta": a.meta, "error": a.meta.get("error", "ダウンロード失敗")}
        for a in answers
    ]
    batch, batch_id = _grade_batch(items, rubric)
    return render_template(
        "scans_result.html", batch=batch, batch_id=batch_id, grader_name=GRADER_NAME,
    )


@app.route("/toshin-debug")
def toshin_debug():
    """東進取得失敗時のスクリーンショットをブラウザで表示する(セレクタ調整用)。"""
    debug_dir = os.environ.get("TOSHIN_DEBUG_DIR", "/tmp")
    path = os.path.join(debug_dir, "debug_toshin_error.png")
    if not os.path.exists(path):
        return (
            "デバッグ用スクリーンショットがありません。"
            "先に「東進から自動取込」を実行して失敗した後にアクセスしてください。",
            404,
        )
    return send_file(path, mimetype="image/png")


@app.route("/toshin-debug-html")
def toshin_debug_html():
    """東進取得失敗時のページHTMLを表示する(セレクタ調整用)。"""
    debug_dir = os.environ.get("TOSHIN_DEBUG_DIR", "/tmp")
    path = os.path.join(debug_dir, "debug_toshin_error.html")
    if not os.path.exists(path):
        return ("デバッグ用HTMLがありません。", 404)
    with open(path, encoding="utf-8") as fh:
        return Response(fh.read(), mimetype="text/plain; charset=utf-8")


def _build_annotated(data: dict) -> bytes:
    """保存されている(手動修正後の)書き込み位置から添削済みPDFを生成する。"""
    marks = [Mark(**m) for m in data.get("marks", [])]
    return annotate_pdf(data["pdf_bytes"], marks)


@app.route("/annotated/<result_id>")
def download_annotated(result_id: str):
    """赤ペン書き込み済み答案PDFのダウンロード(現在の書き込み位置で生成)。"""
    data = _results.get(result_id)
    if data is None or "pdf_bytes" not in data:
        abort(404)
    name = data.get("filename", "答案.pdf").rsplit(".", 1)[0]
    return send_file(
        io.BytesIO(_build_annotated(data)),
        mimetype="application/pdf",
        as_attachment=True,
        download_name=f"{name}_添削済み.pdf",
    )


@app.route("/annotated-zip/<batch_id>")
def download_annotated_zip(batch_id: str):
    """バッチ内の書き込み済みPDFをまとめてZIPでダウンロード。"""
    import zipfile

    ids = _results.get(f"batch:{batch_id}")
    if not ids:
        abort(404)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for rid in ids:
            data = _results.get(rid)
            if data and "pdf_bytes" in data:
                name = data.get("filename", f"{rid}.pdf").rsplit(".", 1)[0]
                zf.writestr(f"{name}_添削済み.pdf", _build_annotated(data))
    buf.seek(0)
    return send_file(
        buf, mimetype="application/zip",
        as_attachment=True, download_name="添削済み答案.zip",
    )


@app.route("/edit/<result_id>")
def edit_marks(result_id: str):
    """採点記号を手動修正するプレビュー編集画面。"""
    data = _results.get(result_id)
    if data is None or "pdf_bytes" not in data:
        abort(404)
    if "page_pngs" not in data:
        data["page_pngs"] = render_pages_png(data["pdf_bytes"], scale=1.5)
    return render_template(
        "editor.html",
        result_id=result_id,
        filename=data.get("filename", "答案"),
        marks=data.get("marks", []),
        page_count=len(data["page_pngs"]),
    )


@app.route("/page-image/<result_id>/<int:page>")
def page_image(result_id: str, page: int):
    """編集画面用の答案ページ画像(PNG)。"""
    data = _results.get(result_id)
    if data is None or "pdf_bytes" not in data:
        abort(404)
    if "page_pngs" not in data:
        data["page_pngs"] = render_pages_png(data["pdf_bytes"], scale=1.5)
    pngs = data["page_pngs"]
    if page < 1 or page > len(pngs):
        abort(404)
    return send_file(io.BytesIO(pngs[page - 1]), mimetype="image/png")


@app.route("/save-marks/<result_id>", methods=["POST"])
def save_marks(result_id: str):
    """手動修正した書き込み位置を保存する。"""
    data = _results.get(result_id)
    if data is None or "pdf_bytes" not in data:
        abort(404)
    payload = request.get_json(force=True, silent=True) or {}
    raw = payload.get("marks", [])
    marks = []
    for m in raw:
        try:
            marks.append(Mark(**m).model_dump())
        except Exception:
            continue
    data["marks"] = marks
    return {"ok": True, "count": len(marks)}


@app.route("/result/<result_id>")
def show_result(result_id: str):
    """採点結果レポートのWeb表示(スキャン採点用)。"""
    data = _results.get(result_id)
    if data is None:
        abort(404)
    return render_template(
        "result.html",
        result=data["result"],
        result_id=result_id,
        genre_label=data.get("genre_label", ""),
        questions=data.get("questions", []),
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
