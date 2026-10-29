"""Discordなしでカード画像を試し描きする。

    python3 scripts/preview.py [出力先.png] [マスの数]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from smashbingo.bingo import Card
from smashbingo.render import render_card

out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("preview.png")
size = int(sys.argv[2]) if len(sys.argv) > 2 else 5

card = Card.create(owner_id=0, owner_name="プレビュー", size=size, seed="preview")
for i in (0, 6, 18, 24, 3, 8):
    if i < size * size:
        card.toggle(i)
out.write_bytes(render_card(card))
print(f"{out} を書き出しました")
