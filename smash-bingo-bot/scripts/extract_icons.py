"""配布元のアイコンシート画像から、ファイターごとのアイコンを切り出す。

    python3 scripts/extract_icons.py assets/_src/sheet.jpg

シートは 7列×16行、公式のファイター順。カラーバリエーション（ナナ、
ポケモン、コクッパ、勇者の別主人公など）も1枠ずつ占めているので、
代表の1枚だけを各ファイターに割り当てる。
カズヤ・ソラはこのシートに含まれていないため、画像なしで文字表示になる。
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "assets" / "icons"

# シート上の位置 (行, 列) -> ファイターのアイコンID
TILE_MAP: dict[tuple[int, int], str] = {
    (0, 0): "mario", (0, 1): "donkey_kong", (0, 2): "link", (0, 3): "samus",
    (0, 4): "dark_samus", (0, 5): "yoshi", (0, 6): "kirby",
    (1, 0): "fox", (1, 1): "pikachu", (1, 2): "luigi", (1, 3): "ness",
    (1, 4): "captain_falcon", (1, 5): "jigglypuff", (1, 6): "peach",
    (2, 0): "daisy", (2, 1): "bowser", (2, 2): "ice_climbers",
    # (2, 3) はナナ（アイスクライマー2人目）なので使わない
    (2, 4): "sheik", (2, 5): "zelda", (2, 6): "dr_mario",
    (3, 0): "pichu", (3, 1): "falco", (3, 2): "marth", (3, 3): "lucina",
    (3, 4): "young_link", (3, 5): "ganondorf", (3, 6): "mewtwo",
    (4, 0): "roy", (4, 1): "chrom", (4, 2): "game_and_watch",
    (4, 3): "meta_knight", (4, 4): "pit", (4, 5): "dark_pit",
    (4, 6): "zero_suit_samus",
    (5, 0): "wario", (5, 1): "snake", (5, 2): "ike",
    (5, 3): "pokemon_trainer",
    # (5,4)〜(6,0) はポケモントレーナー（女）・ゼニガメ・フシギソウ・リザードン
    (6, 1): "diddy_kong", (6, 2): "lucas", (6, 3): "sonic",
    (6, 4): "king_dedede", (6, 5): "olimar",
    # (6, 6) はアルフ
    (7, 0): "lucario", (7, 1): "rob", (7, 2): "toon_link", (7, 3): "wolf",
    (7, 4): "villager",
    # (7, 5) はむらびと（女）
    (7, 6): "mega_man",
    (8, 0): "wii_fit_trainer",
    # (8, 1) はWii Fit トレーナー（男）
    (8, 2): "rosalina", (8, 3): "little_mac", (8, 4): "greninja",
    (8, 5): "mii_brawler", (8, 6): "mii_swordfighter",
    (9, 0): "mii_gunner", (9, 1): "palutena", (9, 2): "pac_man",
    (9, 3): "robin",
    # (9, 4) はルフレ（女）
    (9, 5): "shulk", (9, 6): "bowser_jr",
    # 10行目はコクッパ7人
    (11, 0): "duck_hunt", (11, 1): "ryu", (11, 2): "ken", (11, 3): "cloud",
    (11, 4): "corrin",
    # (11, 5) はカムイ（女）
    (11, 6): "bayonetta",
    (12, 0): "inkling",
    # (12, 1) はインクリング（男）
    (12, 2): "ridley", (12, 3): "simon", (12, 4): "richter",
    (12, 5): "king_k_rool", (12, 6): "isabelle",
    (13, 0): "incineroar", (13, 1): "piranha_plant", (13, 2): "joker",
    (13, 3): "hero",
    # (13, 4)〜(13, 6) は勇者の別主人公
    (14, 0): "banjo_kazooie", (14, 1): "terry", (14, 2): "byleth",
    # (14, 3) はベレス（女）
    (14, 4): "min_min", (14, 5): "steve",
    # (14, 6)〜(15, 1) はアレックス・ゾンビ・エンダーマン
    (15, 2): "sephiroth", (15, 3): "pyra_mythra",
    # (15, 4) はヒカリ
}

COLS, ROWS = 7, 16
SIZE = 160          # 出力アイコンの一辺
BLACK_CUTOFF = 28   # これより暗い画素は真っ黒に均す（JPEGノイズ消し）


def extract(sheet_path: Path) -> int:
    sheet = Image.open(sheet_path).convert("RGB")
    w, h = sheet.size

    # 余白を除いたアイコン領域を、明るい画素の範囲から求める
    bbox = sheet.point(lambda v: 255 if v > 30 else 0).convert("L").getbbox()
    if bbox is None:
        raise SystemExit("アイコンが見つかりませんでした")
    x0, y0, x1, y1 = bbox
    pitch_x = (x1 - x0) / COLS
    pitch_y = (y1 - y0) / ROWS

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    count = 0
    for (row, col), icon_id in sorted(TILE_MAP.items()):
        left = round(x0 + pitch_x * col)
        top = round(y0 + pitch_y * row)
        tile = sheet.crop((left, top, round(left + pitch_x), round(top + pitch_y)))
        tile = tile.point(lambda v: 0 if v < BLACK_CUTOFF else v)
        tile = tile.resize((SIZE, SIZE), Image.LANCZOS)
        tile.save(OUT_DIR / f"{icon_id}.png")
        count += 1
    return count


if __name__ == "__main__":
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "assets/_src/sheet.jpg"
    n = extract(src)
    print(f"{n} 個のアイコンを {OUT_DIR} に書き出しました")
