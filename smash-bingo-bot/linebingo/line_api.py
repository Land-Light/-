"""LINE Messaging API とのやりとり。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os

import httpx

log = logging.getLogger("linebingo.line")

CHANNEL_SECRET = os.environ.get("LINE_CHANNEL_SECRET", "")
CHANNEL_ACCESS_TOKEN = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "")

REPLY_URL = "https://api.line.me/v2/bot/message/reply"


def verify_signature(body: bytes, signature: str) -> bool:
    """Webhookが本当にLINEから来たものか確かめる。"""
    if not CHANNEL_SECRET:
        log.warning("LINE_CHANNEL_SECRET が未設定です")
        return False
    digest = hmac.new(CHANNEL_SECRET.encode(), body, hashlib.sha256).digest()
    return hmac.compare_digest(base64.b64encode(digest).decode(), signature or "")


async def reply(reply_token: str, messages: list[dict]) -> None:
    if not CHANNEL_ACCESS_TOKEN:
        log.warning("LINE_CHANNEL_ACCESS_TOKEN が未設定のため返信できません")
        return
    async with httpx.AsyncClient(timeout=15) as client:
        res = await client.post(
            REPLY_URL,
            headers={"Authorization": f"Bearer {CHANNEL_ACCESS_TOKEN}"},
            json={"replyToken": reply_token, "messages": messages})
        if res.status_code >= 300:
            log.error("返信に失敗 %s %s", res.status_code, res.text)


def text(message: str) -> dict:
    return {"type": "text", "text": message}


def image(url: str) -> dict:
    return {"type": "image", "originalContentUrl": url, "previewImageUrl": url}
