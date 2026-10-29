"""ビンゴカードのデータと判定ロジック。"""

from __future__ import annotations

import random
import secrets
import time
from dataclasses import dataclass, field

from .fighters import Fighter, pool

FREE_LABEL = "FREE"


class NotEnoughFighters(Exception):
    """抽選候補がマス目の数に足りないとき。"""

    def __init__(self, needed: int, available: int):
        super().__init__(f"マスが{needed}個に対して候補が{available}体しかありません")
        self.needed = needed
        self.available = available


@dataclass
class Card:
    id: str
    size: int
    cells: list[str]                      # マスに並ぶファイター名（FREEは FREE_LABEL）
    free_index: int | None                # FREEマスの位置
    owner_id: int                         # 作成者
    owner_name: str
    marked: set[int] = field(default_factory=set)
    seed: str | None = None
    anyone: bool = False                  # 誰でもマークできるか
    settings: dict = field(default_factory=dict)
    message_id: int | None = None
    channel_id: int | None = None
    created_at: float = field(default_factory=time.time)

    # ---------- 生成 ----------
    @classmethod
    def create(cls, owner_id: int, owner_name: str, size: int = 5,
               free: bool = False, include_dlc: bool = True,
               include_echo: bool = True, include_mii: bool = False,
               exclude: list[str] | None = None,
               seed: str | None = None, anyone: bool = False) -> "Card":
        candidates = pool(include_dlc=include_dlc, include_echo=include_echo,
                          include_mii=include_mii, exclude=exclude)
        free_index = (size * size) // 2 if (free and size % 2 == 1) else None
        needed = size * size - (1 if free_index is not None else 0)
        if len(candidates) < needed:
            raise NotEnoughFighters(needed, len(candidates))

        rng = random.Random(seed) if seed else random.Random()
        picked: list[Fighter] = rng.sample(candidates, needed)

        cells: list[str] = []
        it = iter(picked)
        for i in range(size * size):
            cells.append(FREE_LABEL if i == free_index else next(it).name)

        card = cls(
            id=secrets.token_urlsafe(8),
            size=size,
            cells=cells,
            free_index=free_index,
            owner_id=owner_id,
            owner_name=owner_name,
            seed=seed,
            anyone=anyone,
            settings={
                "free": free_index is not None,
                "include_dlc": include_dlc,
                "include_echo": include_echo,
                "include_mii": include_mii,
                "exclude": list(exclude or []),
                "pool_size": len(candidates),
            },
        )
        if free_index is not None:
            card.marked.add(free_index)
        return card

    def reroll(self) -> "Card":
        """同じ設定で引き直した新しいカードを作る（シードは引き継がない）。"""
        s = self.settings
        return Card.create(
            owner_id=self.owner_id,
            owner_name=self.owner_name,
            size=self.size,
            free=s.get("free", False),
            include_dlc=s.get("include_dlc", True),
            include_echo=s.get("include_echo", True),
            include_mii=s.get("include_mii", False),
            exclude=s.get("exclude", []),
            seed=None,
            anyone=self.anyone,
        )

    # ---------- 操作 ----------
    def can_mark(self, user_id: int) -> bool:
        return self.anyone or user_id == self.owner_id

    def toggle(self, index: int) -> bool:
        """マスを反転して、マーク後の状態を返す。FREEマスは常にマーク済み。"""
        if index == self.free_index:
            return True
        if index in self.marked:
            self.marked.discard(index)
            return False
        self.marked.add(index)
        return True

    def clear(self) -> None:
        self.marked = {self.free_index} if self.free_index is not None else set()

    # ---------- 判定 ----------
    def lines(self) -> list[list[int]]:
        n = self.size
        result = [[r * n + c for c in range(n)] for r in range(n)]
        result += [[r * n + c for r in range(n)] for c in range(n)]
        result.append([i * n + i for i in range(n)])
        result.append([i * n + (n - 1 - i) for i in range(n)])
        return result

    def completed_lines(self) -> list[list[int]]:
        return [line for line in self.lines() if all(i in self.marked for i in line)]

    def reach_count(self) -> int:
        """あと1マスでビンゴになる列の数。"""
        count = 0
        for line in self.lines():
            remaining = [i for i in line if i not in self.marked]
            if len(remaining) == 1:
                count += 1
        return count

    def is_full(self) -> bool:
        return len(self.marked) == self.size * self.size

    # ---------- 保存 ----------
    def to_dict(self) -> dict:
        data = self.__dict__.copy()
        data["marked"] = sorted(self.marked)
        return data

    @classmethod
    def from_dict(cls, data: dict) -> "Card":
        data = dict(data)
        data["marked"] = set(data.get("marked", []))
        known = cls.__dataclass_fields__.keys()
        return cls(**{k: v for k, v in data.items() if k in known})
