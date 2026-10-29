"""スマブラ キャラビンゴ（LINE版）。

トークで「ビンゴ」と送ると、ランダムなキャラが並んだビンゴカードの画像を
返すだけのボット。

カードはシード文字列から毎回同じものを組み立て直せるので、画像を保存して
おく必要がない。LINEは画像URLを取りに来るだけなので、/c/<シード>.png で
その場で描いて返す。
"""

from __future__ import annotations

import logging
import os
import re
import secrets

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from smashbingo.bingo import Card
from smashbingo.render import render_card
from . import line_api

log = logging.getLogger("linebingo")

# 公開URL。ふだんはリクエストのヘッダーから分かるので設定不要。
# リバースプロキシの構成によっては BASE_URL で上書きする。
BASE_URL = os.environ.get("BASE_URL", "").rstrip("/")

SIZE = int(os.environ.get("BINGO_SIZE", "5"))
SEED_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")

app = FastAPI(title="スマブラ キャラビンゴ (LINE)")


def build_card(seed: str) -> Card:
    """シードから、いつでも同じカードを組み立てる。"""
    return Card.create(owner_id=0, owner_name="", size=SIZE, free=False,
                       include_mii=False, seed=seed)


def public_base(request: Request) -> str:
    """LINEから画像を取りに来られるURLを組み立てる。"""
    if BASE_URL:
        return BASE_URL
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    return f"{proto}://{host}"


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


@app.get("/c/{seed}.png")
async def card_image(seed: str) -> Response:
    if not SEED_RE.match(seed):
        raise HTTPException(status_code=404, detail="not found")
    png = render_card(build_card(seed))
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.post("/callback")
async def callback(request: Request, background: BackgroundTasks,
                   x_line_signature: str = Header(default="")) -> JSONResponse:
    body = await request.body()
    if not line_api.verify_signature(body, x_line_signature):
        raise HTTPException(status_code=400, detail="署名が一致しません")

    # 返信はバックグラウンドに回して、LINEにはすぐ200を返す
    base = public_base(request)
    for event in (await request.json()).get("events", []):
        kind = event.get("type")
        token = event.get("replyToken")
        if not token:
            continue
        if kind == "message" and event.get("message", {}).get("type") == "text":
            background.add_task(handle_text, token,
                                event["message"].get("text", ""), base)
        elif kind in ("join", "follow"):
            background.add_task(line_api.reply, token, [line_api.text(
                "スマブラ キャラビンゴです。\n「ビンゴ」と送るとカードを作ります。")])
    return JSONResponse({"ok": True})


async def handle_text(reply_token: str, message: str, base: str) -> None:
    if "ビンゴ" not in message:
        return
    seed = secrets.token_urlsafe(6)
    await line_api.reply(reply_token, [line_api.image(f"{base}/c/{seed}.png")])


def main() -> None:
    import uvicorn
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))


if __name__ == "__main__":
    main()
