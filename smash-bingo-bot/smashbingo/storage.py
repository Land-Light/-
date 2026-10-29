"""カードをJSONに保存して、再起動後もボタンが動くようにする。"""

from __future__ import annotations

import json
from pathlib import Path

from .bingo import Card

MAX_CARDS = 300  # これを超えたら古いものから捨てる


class CardStore:
    def __init__(self, path: Path):
        self.path = path
        self.cards: dict[str, Card] = {}
        self.load()

    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return
        for data in raw.get("cards", []):
            try:
                card = Card.from_dict(data)
            except (TypeError, KeyError):
                continue
            self.cards[card.id] = card

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        cards = sorted(self.cards.values(), key=lambda c: c.created_at)[-MAX_CARDS:]
        self.cards = {c.id: c for c in cards}
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({"cards": [c.to_dict() for c in cards]}, ensure_ascii=False),
            encoding="utf-8")
        tmp.replace(self.path)

    def add(self, card: Card) -> None:
        self.cards[card.id] = card
        self.save()

    def get(self, card_id: str) -> Card | None:
        return self.cards.get(card_id)

    def latest_for(self, user_id: int, channel_id: int | None = None) -> Card | None:
        """その人が最後に作ったカード。"""
        found = [c for c in self.cards.values() if c.owner_id == user_id
                 and (channel_id is None or c.channel_id == channel_id)]
        return max(found, key=lambda c: c.created_at) if found else None
