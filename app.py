"""国語入試 過去問添削AI — Flask アプリ本体。"""

import base64
import concurrent.futures
import io
import os
import threading
import uuid

from flask import (
    Flask, Response, abort, jsonify, redirect, render_template, request,
    send_file, url_for,
)

from annotator import Mark, annotate_pdf
from grader import GENRE_LABELS, GRADER_NAME, QuestionInput, grade_answers
from pdf_generator import build_pdf
from scan_grader import (
    build_marks, decide_tensakit_marks, grade_scanned_pdf,
    is_short_answer_section, render_pages_png,
)
from toshin_fetcher import (
    ToshinFetchError, batch_grade_on_tensakit, fetch_answers,
    grade_and_submit_on_tensakit, inspect_tensakit,
)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 256 * 1024 * 1024  # アップロード上限 256MB(大量枚数対応)

# 一括採点の並列数。答案採点はAPI待ちが大半なので並列化で総時間を短縮できる。
# メモリ(無料枠512MB)とAPIレート制限を考慮した既定値。環境変数で調整可。
# 無料プラン(512MB)ではメモリ上限超過で再起動されやすいため、既定は逐次(1)。
# メモリに余裕のある有料プランでは環境変数 GRADE_CONCURRENCY=3 等で高速化できる。
GRADE_CONCURRENCY = max(1, int(os.environ.get("GRADE_CONCURRENCY", "1")))

# 添削結果の一時保存(PDF ダウンロード用)。プロセス内メモリ保持。
_results: dict = {}
# バッチ処理の進捗(取得・採点をバックグラウンドで実行し、画面はポーリングで進捗表示)
_batches: dict = {}


def _grade_one_into(slot: dict, item: dict, rubric):
    """1枚を採点し、結果を _results に保存して slot(進捗表示用)を更新する。"""
    slot["status"] = "grading"
    pdf_bytes = item.get("pdf_bytes")
    if not pdf_bytes:
        slot.update(status="error", error=item.get("error", "ダウンロード失敗"))
        return
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
        slot.update(
            status="done", result_id=result_id,
            exam=result.matched_exam, score=result.total_score,
            max_score=result.max_score, grade=result.grade_label,
            tensakit_url=(item.get("source_meta") or {}).get("tensakit_url"),
        )
    except Exception as e:  # 1枚の失敗で全体を止めない
        slot.update(status="error", error=str(e))


def _grade_items_bg(state: dict, items: list, rubric):
    """items を並列採点し、state["items"] の各 slot を更新する。"""
    state["items"] = [{"filename": it["filename"], "status": "pending"} for it in items]
    state["total"] = len(items)
    state["phase"] = "grading"
    workers = min(GRADE_CONCURRENCY, max(1, len(items)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(_grade_one_into, state["items"][i], it, rubric)
                for i, it in enumerate(items)]
        for f in concurrent.futures.as_completed(futs):
            f.result()
    state["phase"] = "done"


def _new_batch() -> str:
    batch_id = uuid.uuid4().hex
    _batches[batch_id] = {"phase": "starting", "total": 0, "items": [], "error": None}
    return batch_id


def _start_scan_batch(items: list, rubric) -> str:
    """アップロード済みPDF群をバックグラウンドで採点開始し、batch_id を返す。"""
    batch_id = _new_batch()
    state = _batches[batch_id]

    def worker():
        try:
            _grade_items_bg(state, items, rubric)
        except Exception as e:
            state.update(phase="error", error=str(e))

    threading.Thread(target=worker, daemon=True).start()
    return batch_id


def _start_toshin_batch(max_count: int, rubric) -> str:
    """東進から取得→採点までをバックグラウンドで実行し、batch_id を返す。"""
    batch_id = _new_batch()
    state = _batches[batch_id]
    state["phase"] = "fetching"

    def worker():
        try:
            answers = fetch_answers(max_count=max_count)
        except ToshinFetchError as e:
            state.update(phase="error", error=f"東進からの取得に失敗しました: {e}")
            return
        except Exception as e:
            state.update(phase="error", error=f"東進からの取得に失敗しました: {e}")
            return
        items = [
            {"filename": a.filename, "pdf_bytes": a.pdf_bytes,
             "source_meta": a.meta, "error": a.meta.get("error", "ダウンロード失敗")}
            for a in answers
        ]
        if not items:
            state.update(phase="error", error="取得できる答案がありませんでした。")
            return
        try:
            _grade_items_bg(state, items, rubric)
        except Exception as e:
            state.update(phase="error", error=str(e))

    threading.Thread(target=worker, daemon=True).start()
    return batch_id


def _start_tensakit_batch(max_count: int, rubric, submit: bool) -> str:
    """東進から取得し、PDFを作らずそのまま Tensakit で一括採点する(バックグラウンド)。"""
    batch_id = _new_batch()
    state = _batches[batch_id]
    state["phase"] = "grading"
    state["mode"] = "tensakit"
    state["submit"] = submit
    state["total"] = max_count  # 上限(緑スキップで実数は減ることがある)
    state["items"] = []

    def decide_fn(page_images, sections):
        return decide_tensakit_marks(page_images, sections, rubric=rubric)

    def progress(index: int, done: int, item: dict):
        while len(state["items"]) <= index:
            state["items"].append({"filename": item.get("filename", ""), "status": "grading"})
        slot = state["items"][index]
        slot["filename"] = item.get("filename", slot.get("filename", ""))
        slot["exam"] = item.get("filename", slot.get("exam", ""))
        slot["status"] = item.get("status", slot.get("status"))
        slot["tensakit_url"] = item.get("tensakit_url")
        if item.get("status") == "done":
            rep = item.get("report") or {}
            slot["note"] = (
                f"加点/減点チェック {rep.get('checked', 0)} 件・"
                f"コメント {rep.get('commented', 0)} 件 → "
                + ("提出済" if rep.get("submitted") else
                   ("下書き保存済(未提出)" if rep.get("saved") else "未保存"))
            )
        elif item.get("status") == "error":
            slot["error"] = item.get("error", "")

    def worker():
        try:
            batch_grade_on_tensakit(max_count, decide_fn, submit=submit, progress=progress)
            state["total"] = max(1, len(state["items"]))
            state["phase"] = "done"
        except ToshinFetchError as e:
            state.update(phase="error", error=str(e))
        except Exception as e:
            state.update(phase="error", error=str(e))

    threading.Thread(target=worker, daemon=True).start()
    return batch_id

# サイトを開くときのパスワードは不要にする(利用者の希望により無効化)。
# 再びパスワードを掛けたくなった場合は、環境変数 APP_PASSWORD を設定したうえで
# 下の _require_password の中身を元(Basic認証)に戻すこと。
_APP_PASSWORD = ""


@app.before_request
def _require_password():
    # パスワード認証は無効(どのページも認証なしで開ける)。
    return None


@app.after_request
def _cors(resp):
    """ブックマークレット(Tensakit画面から)がAPI/スクリプトを呼べるようにCORSを許可。"""
    if request.path.startswith("/api/") or request.path in ("/tensakit-bm.js", "/tensakit-dump.js"):
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
    return resp


@app.route("/api/tensakit-decide", methods=["POST", "OPTIONS"])
def api_tensakit_decide():
    """ブックマークレットから答案画像+パネル選択肢を受け取り、AIが加点/減点を判断して返す。

    サーバー側でブラウザを起動しないため、無料プラン(512MB)でも動く。
    """
    if request.method == "OPTIONS":
        return ("", 204)
    data = request.get_json(force=True, silent=True) or {}
    # 採点パネルの実際のHTMLを保存(構造調整用。/tensakit-html で確認)
    panel_html = data.get("panel_html")
    if panel_html:
        try:
            debug_dir = os.environ.get("TOSHIN_DEBUG_DIR", "/tmp")
            with open(os.path.join(debug_dir, "tensakit_page.html"), "w", encoding="utf-8") as fh:
                fh.write(panel_html)
        except Exception:
            pass
    sections = data.get("sections") or []
    if not sections:
        return jsonify({"error": "採点パネルの選択肢を受け取れませんでした。"})
    images = []
    fetch_fail = []  # 取得に失敗したURLの状況(診断用)
    # data: URL(埋め込み画像)はその場でデコード
    for du in (data.get("images") or []):
        if isinstance(du, str) and du.startswith("data:"):
            try:
                images.append(base64.b64decode(du.split(",", 1)[1]))
            except Exception:
                pass
    url_list = [u for u in (data.get("image_urls") or []) if isinstance(u, str)][:8]
    # 答案画像URL(S3等)はサーバー側で取得する(ブラウザのCORS制限を受けない)
    for u in url_list:
        if u.startswith("data:"):
            try:
                images.append(base64.b64decode(u.split(",", 1)[1]))
            except Exception:
                fetch_fail.append("data:decode")
        elif u.startswith("http"):
            try:
                import httpx
                r = httpx.get(u, timeout=30.0, follow_redirects=True)
                if r.status_code == 200 and r.content:
                    images.append(r.content)
                else:
                    fetch_fail.append("HTTP " + str(r.status_code))
            except Exception as e:
                fetch_fail.append(type(e).__name__)
    try:
        decisions = decide_tensakit_marks(images, sections, rubric=None)
    except Exception as e:
        msg = str(e)
        if "overload" in msg.lower():
            msg = "AIが混雑しています。少し待ってからもう一度実行してください。"
        return jsonify({"error": msg})
    out = [
        {"section_label": d.section_label,
         "add_indices": d.add_indices, "deduct_indices": d.deduct_indices,
         "radio_index": d.radio_index, "deduct_numbers": d.deduct_numbers}
        for d in decisions
    ]
    with_sel = sum(1 for d in decisions
                   if d.add_indices or d.deduct_indices or d.radio_index is not None)
    short_skipped = sum(1 for s in sections if is_short_answer_section(s))
    debug = {
        "images_ok": len(images),
        "img_urls": len(url_list),
        "fetch_fail": fetch_fail[:6],
        "sections_in": len(sections),
        "short_skipped": short_skipped,  # 漢字・短答(手動採点。AI対象外)
        "decided": len(decisions),
        "with_selection": with_sel,
    }
    return jsonify({"sections": out, "debug": debug})


@app.route("/tensakit-bm.js")
def tensakit_bm_js():
    """ブックマークレット本体(Tensakit画面に注入されるスクリプト)を配信する。"""
    base = request.host_url  # 末尾 / 付き
    path = os.path.join(app.root_path, "tensakit_bm.js")
    with open(path, encoding="utf-8") as fh:
        js = fh.read().replace("__API_BASE__", base)
    return Response(js, mimetype="application/javascript")


@app.route("/tensakit-dump.js")
def tensakit_dump_js():
    """構造取得(開発用)ブックマークレット本体を配信する(採点せずHTMLをコピー)。"""
    path = os.path.join(app.root_path, "tensakit_dump.js")
    with open(path, encoding="utf-8") as fh:
        js = fh.read()
    return Response(js, mimetype="application/javascript")


@app.route("/bookmarklet")
def bookmarklet_page():
    """ブックマークレットの登録手順を表示するページ。"""
    base = request.host_url
    loader = (
        "javascript:(function(){var d=document,s=d.createElement('script');"
        "s.src='" + base + "tensakit-bm.js?t='+Date.now();"
        "s.onerror=function(){alert('スクリプトを読み込めませんでした(サイトのCSP制限の可能性)');};"
        "d.body.appendChild(s);})();"
    )
    dump_loader = (
        "javascript:(function(){var d=document,s=d.createElement('script');"
        "s.src='" + base + "tensakit-dump.js?t='+Date.now();"
        "d.body.appendChild(s);})();"
    )
    return render_template("bookmarklet.html", loader=loader, dump_loader=dump_loader, base=base)


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
    """スキャン答案PDF(複数可)をバックグラウンドで一括採点し進捗画面へ。"""
    files = [f for f in request.files.getlist("scans") if f and f.filename]
    rubric = request.form.get("scan_rubric", "").strip() or None
    if not files:
        return render_template(
            "index.html", genres=GENRE_LABELS,
            error="答案PDFを1つ以上選択してください。", form=request.form,
        ), 400

    items = [{"filename": f.filename, "pdf_bytes": f.read()} for f in files]
    batch_id = _start_scan_batch(items, rubric)
    return redirect(url_for("batch_progress", batch_id=batch_id))


@app.route("/fetch-toshin", methods=["POST"])
def fetch_toshin():
    """東進から取得→採点をバックグラウンドで開始し、進捗画面へ即座に遷移する。"""
    rubric = request.form.get("toshin_rubric", "").strip() or None
    try:
        max_count = int(request.form.get("toshin_max", "10"))
    except ValueError:
        max_count = 10
    batch_id = _start_toshin_batch(max_count, rubric)
    return redirect(url_for("batch_progress", batch_id=batch_id))


@app.route("/grade-tensakit", methods=["POST"])
def grade_tensakit():
    """東進から取得し、PDFを作らずそのまま Tensakit で一括採点する。

    フォームの submit=on のときだけ提出まで行う(既定は下書き保存のみ)。
    """
    rubric = request.form.get("toshin_rubric", "").strip() or None
    try:
        max_count = int(request.form.get("toshin_max", "10"))
    except ValueError:
        max_count = 10
    submit = request.form.get("submit") in ("on", "1", "true")
    batch_id = _start_tensakit_batch(max_count, rubric, submit)
    return redirect(url_for("batch_progress", batch_id=batch_id))


@app.route("/batch/<batch_id>")
def batch_progress(batch_id: str):
    """一括採点の進捗画面(JSでポーリングして完了分から表示)。"""
    if batch_id not in _batches:
        abort(404)
    return render_template("batch_status.html", batch_id=batch_id, grader_name=GRADER_NAME)


@app.route("/batch-status/<batch_id>")
def batch_status(batch_id: str):
    """進捗を JSON で返す(バックグラウンド採点のポーリング用)。"""
    state = _batches.get(batch_id)
    if state is None:
        abort(404)
    items = state.get("items", [])
    done = sum(1 for it in items if it.get("status") in ("done", "error"))
    return {
        "phase": state.get("phase"),
        "error": state.get("error"),
        "total": state.get("total", 0),
        "done": done,
        "items": items,
    }


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


@app.route("/tensakit-inspect", methods=["POST", "GET"])
def tensakit_inspect():
    """Tensakit(東進オンライン採点)画面の構造を取得する(採点入力自動化の設計用)。"""
    try:
        info = inspect_tensakit()
    except ToshinFetchError as e:
        return render_template(
            "index.html", genres=GENRE_LABELS,
            error=f"Tensakit画面の取得に失敗しました: {e}(/toshin-debug で失敗画面を確認できます)",
            form={},
        ), 502
    return (
        "<h3>Tensakit採点画面を取得しました</h3>"
        f"<p>URL: {info.get('url')}<br>タイトル: {info.get('title')}</p>"
        "<p><a href='/tensakit-page'>スクリーンショットを見る</a> / "
        "<a href='/tensakit-html'>HTMLを見る</a></p>"
        "<p>この2つを開発者に共有すると、採点入力の自動化を作成できます。</p>"
        "<p><a href='/'>戻る</a></p>"
    )


@app.route("/tensakit-grade/<result_id>", methods=["POST", "GET"])
def tensakit_grade(result_id: str):
    """採点済みの1件を Tensakit 採点画面に自動入力する(既定は下書き保存のみ)。

    ?submit=1 を付けると提出まで行う。提出は取り消しにくいので既定は保存のみ。
    """
    data = _results.get(result_id)
    if not data:
        abort(404)
    href = (data.get("source_meta") or {}).get("tensakit_url")
    if not href:
        return ("この答案には Tensakit のリンクがありません(東進取込の答案のみ対応)。", 400)
    submit = request.values.get("submit") in ("1", "true", "on")
    pdf_bytes = data["pdf_bytes"]
    rubric = data.get("rubric")

    def decide_fn(sections):
        # 保存済みのPDFを低解像度で描画して渡す(単発版)
        imgs = render_pages_png(pdf_bytes, scale=1.4)[:6]
        return decide_tensakit_marks(imgs, sections, rubric=rubric)

    try:
        report = grade_and_submit_on_tensakit(href, decide_fn, submit=submit)
    except ToshinFetchError as e:
        return (f"<h3>Tensakit 自動採点に失敗しました</h3><p>{e}</p>"
                "<p><a href='/tensakit-page'>実行時の画面を見る</a></p>"
                "<p><a href='/'>戻る</a></p>"), 502
    action = "提出まで完了" if report.get("submitted") else "下書き保存まで完了(未提出)"
    return (
        f"<h3>Tensakit 自動採点: {action}</h3>"
        f"<p>セクション {report['sections']} 件 / チェック {report['checked']} 件 / "
        f"コメント {report['commented']} 件 / 保存 {'○' if report['saved'] else '×'}</p>"
        "<p>入力結果を確認してください: "
        "<a href='/tensakit-page' target='_blank'>実行後の画面</a></p>"
        + ("" if submit else
           f"<p><a href='/tensakit-grade/{result_id}?submit=1'>"
           "内容を確認できたら『提出』まで実行する</a></p>")
        + "<p><a href='/'>戻る</a></p>"
    )


@app.route("/tensakit-page")
def tensakit_page():
    """取得済みTensakit採点画面のスクリーンショット。"""
    debug_dir = os.environ.get("TOSHIN_DEBUG_DIR", "/tmp")
    path = os.path.join(debug_dir, "tensakit_page.png")
    if not os.path.exists(path):
        return ("まだ取得していません。先に「Tensakit画面を取得」を実行してください。", 404)
    return send_file(path, mimetype="image/png")


@app.route("/tensakit-html")
def tensakit_html():
    """取得済みTensakit採点画面のHTML。"""
    debug_dir = os.environ.get("TOSHIN_DEBUG_DIR", "/tmp")
    path = os.path.join(debug_dir, "tensakit_page.html")
    if not os.path.exists(path):
        return ("まだ取得していません。", 404)
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

    state = _batches.get(batch_id)
    if not state:
        abort(404)
    ids = [it.get("result_id") for it in state.get("items", []) if it.get("result_id")]
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
