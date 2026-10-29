"""スマブラSP の全ファイター（86体）データ。

- 通常ファイター 74体（2018年12月の発売時ロースター。ダッシュファイターと
  Miiファイター3種を含む）
- 追加ファイター 12体（パックンフラワー〜ソラ）

`ホムラ/ヒカリ` はゲーム内で1枠なので1体として数えています。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Fighter:
    name: str      # 正式名称（画像に出す名前）
    short: str     # ボタン用の短い名前
    series: str    # シリーズ名
    dlc: bool = False    # 追加ファイターか
    echo: bool = False   # ダッシュファイターか

    @property
    def icon_id(self) -> str:
        """assets/icons/<icon_id>.png のファイル名。画像が無ければ空文字。"""
        return ICON_IDS.get(self.name, "")

    @property
    def is_mii(self) -> bool:
        return self.series == "Mii"

    def matches(self, query: str) -> bool:
        """除外指定などの文字列と一致するか（ゆるめの判定）。"""
        q = _normalize(query)
        if not q:
            return False
        return q in _normalize(self.name) or q in _normalize(self.short)


def _normalize(text: str) -> str:
    table = str.maketrans({
        "・": "", "＆": "", "&": "", " ": "", "　": "", "／": "", "/": "",
        "(": "", ")": "", "（": "", "）": "", ".": "", "＝": "", "=": "",
    })
    return text.translate(table).lower()


# fmt: off
FIGHTERS: list[Fighter] = [
    Fighter("マリオ", "マリオ", "マリオ"),
    Fighter("ドンキーコング", "ドンキー", "ドンキーコング"),
    Fighter("リンク", "リンク", "ゼルダの伝説"),
    Fighter("サムス", "サムス", "メトロイド"),
    Fighter("ダークサムス", "ダクサム", "メトロイド", echo=True),
    Fighter("ヨッシー", "ヨッシー", "ヨッシー"),
    Fighter("カービィ", "カービィ", "星のカービィ"),
    Fighter("フォックス", "フォックス", "スターフォックス"),
    Fighter("ピカチュウ", "ピカチュウ", "ポケモン"),
    Fighter("ルイージ", "ルイージ", "マリオ"),
    Fighter("ネス", "ネス", "MOTHER"),
    Fighter("キャプテン・ファルコン", "ファルコン", "F-ZERO"),
    Fighter("プリン", "プリン", "ポケモン"),
    Fighter("ピーチ", "ピーチ", "マリオ"),
    Fighter("デイジー", "デイジー", "マリオ", echo=True),
    Fighter("クッパ", "クッパ", "マリオ"),
    Fighter("アイスクライマー", "アイクラ", "アイスクライマー"),
    Fighter("シーク", "シーク", "ゼルダの伝説"),
    Fighter("ゼルダ", "ゼルダ", "ゼルダの伝説"),
    Fighter("ドクターマリオ", "ドクマリ", "マリオ"),
    Fighter("ピチュー", "ピチュー", "ポケモン"),
    Fighter("ファルコ", "ファルコ", "スターフォックス"),
    Fighter("マルス", "マルス", "ファイアーエムブレム"),
    Fighter("ルキナ", "ルキナ", "ファイアーエムブレム", echo=True),
    Fighter("こどもリンク", "こどリン", "ゼルダの伝説"),
    Fighter("ガノンドロフ", "ガノン", "ゼルダの伝説"),
    Fighter("ミュウツー", "ミュウツー", "ポケモン"),
    Fighter("ロイ", "ロイ", "ファイアーエムブレム"),
    Fighter("クロム", "クロム", "ファイアーエムブレム", echo=True),
    Fighter("Mr.ゲーム&ウォッチ", "ゲムヲ", "ゲーム&ウォッチ"),
    Fighter("メタナイト", "メタナイト", "星のカービィ"),
    Fighter("ピット", "ピット", "パルテナの鏡"),
    Fighter("ブラックピット", "ブラピ", "パルテナの鏡", echo=True),
    Fighter("ゼロスーツサムス", "ゼロサム", "メトロイド"),
    Fighter("ワリオ", "ワリオ", "ワリオ"),
    Fighter("スネーク", "スネーク", "メタルギア"),
    Fighter("アイク", "アイク", "ファイアーエムブレム"),
    Fighter("ポケモントレーナー", "ポケトレ", "ポケモン"),
    Fighter("ディディーコング", "ディディー", "ドンキーコング"),
    Fighter("リュカ", "リュカ", "MOTHER"),
    Fighter("ソニック", "ソニック", "ソニック"),
    Fighter("デデデ", "デデデ", "星のカービィ"),
    Fighter("ピクミン&オリマー", "オリマー", "ピクミン"),
    Fighter("ルカリオ", "ルカリオ", "ポケモン"),
    Fighter("ロボット", "ロボット", "ファミコンロボット"),
    Fighter("トゥーンリンク", "トゥーン", "ゼルダの伝説"),
    Fighter("ウルフ", "ウルフ", "スターフォックス"),
    Fighter("むらびと", "むらびと", "どうぶつの森"),
    Fighter("ロックマン", "ロックマン", "ロックマン"),
    Fighter("Wii Fit トレーナー", "WiiFit", "Wii Fit"),
    Fighter("ロゼッタ&チコ", "ロゼチコ", "マリオ"),
    Fighter("リトル・マック", "マック", "パンチアウト!!"),
    Fighter("ゲッコウガ", "ゲッコウガ", "ポケモン"),
    Fighter("Miiファイター(格闘型)", "Mii格闘", "Mii"),
    Fighter("Miiファイター(剣術型)", "Mii剣術", "Mii"),
    Fighter("Miiファイター(射撃型)", "Mii射撃", "Mii"),
    Fighter("パルテナ", "パルテナ", "パルテナの鏡"),
    Fighter("パックマン", "パックマン", "パックマン"),
    Fighter("ルフレ", "ルフレ", "ファイアーエムブレム"),
    Fighter("シュルク", "シュルク", "ゼノブレイド"),
    Fighter("クッパJr.", "クッパJr", "マリオ"),
    Fighter("ダックハント", "ダックハント", "ダックハント"),
    Fighter("リュウ", "リュウ", "ストリートファイター"),
    Fighter("ケン", "ケン", "ストリートファイター", echo=True),
    Fighter("クラウド", "クラウド", "ファイナルファンタジー"),
    Fighter("カムイ", "カムイ", "ファイアーエムブレム"),
    Fighter("ベヨネッタ", "ベヨネッタ", "ベヨネッタ"),
    Fighter("インクリング", "インクリング", "スプラトゥーン"),
    Fighter("リドリー", "リドリー", "メトロイド"),
    Fighter("シモン", "シモン", "悪魔城ドラキュラ"),
    Fighter("リヒター", "リヒター", "悪魔城ドラキュラ", echo=True),
    Fighter("キングクルール", "クルール", "ドンキーコング"),
    Fighter("しずえ", "しずえ", "どうぶつの森"),
    Fighter("ガオガエン", "ガオガエン", "ポケモン"),
    # ここから追加ファイター
    Fighter("パックンフラワー", "パックン", "マリオ", dlc=True),
    Fighter("ジョーカー", "ジョーカー", "ペルソナ", dlc=True),
    Fighter("勇者", "勇者", "ドラゴンクエスト", dlc=True),
    Fighter("バンジョー&カズーイ", "バンカズ", "バンジョーとカズーイの大冒険", dlc=True),
    Fighter("テリー", "テリー", "餓狼伝説", dlc=True),
    Fighter("ベレト/ベレス", "ベレト", "ファイアーエムブレム", dlc=True),
    Fighter("ミェンミェン", "ミェンミェン", "ARMS", dlc=True),
    Fighter("スティーブ", "スティーブ", "Minecraft", dlc=True),
    Fighter("セフィロス", "セフィロス", "ファイナルファンタジー", dlc=True),
    Fighter("ホムラ/ヒカリ", "ホムヒカ", "ゼノブレイド", dlc=True),
    Fighter("カズヤ", "カズヤ", "鉄拳", dlc=True),
    Fighter("ソラ", "ソラ", "キングダム ハーツ", dlc=True),
]
# fmt: on


# ファイター名 -> assets/icons/ のファイル名
ICON_IDS: dict[str, str] = {
    "マリオ": "mario",
    "ドンキーコング": "donkey_kong",
    "リンク": "link",
    "サムス": "samus",
    "ダークサムス": "dark_samus",
    "ヨッシー": "yoshi",
    "カービィ": "kirby",
    "フォックス": "fox",
    "ピカチュウ": "pikachu",
    "ルイージ": "luigi",
    "ネス": "ness",
    "キャプテン・ファルコン": "captain_falcon",
    "プリン": "jigglypuff",
    "ピーチ": "peach",
    "デイジー": "daisy",
    "クッパ": "bowser",
    "アイスクライマー": "ice_climbers",
    "シーク": "sheik",
    "ゼルダ": "zelda",
    "ドクターマリオ": "dr_mario",
    "ピチュー": "pichu",
    "ファルコ": "falco",
    "マルス": "marth",
    "ルキナ": "lucina",
    "こどもリンク": "young_link",
    "ガノンドロフ": "ganondorf",
    "ミュウツー": "mewtwo",
    "ロイ": "roy",
    "クロム": "chrom",
    "Mr.ゲーム&ウォッチ": "game_and_watch",
    "メタナイト": "meta_knight",
    "ピット": "pit",
    "ブラックピット": "dark_pit",
    "ゼロスーツサムス": "zero_suit_samus",
    "ワリオ": "wario",
    "スネーク": "snake",
    "アイク": "ike",
    "ポケモントレーナー": "pokemon_trainer",
    "ディディーコング": "diddy_kong",
    "リュカ": "lucas",
    "ソニック": "sonic",
    "デデデ": "king_dedede",
    "ピクミン&オリマー": "olimar",
    "ルカリオ": "lucario",
    "ロボット": "rob",
    "トゥーンリンク": "toon_link",
    "ウルフ": "wolf",
    "むらびと": "villager",
    "ロックマン": "mega_man",
    "Wii Fit トレーナー": "wii_fit_trainer",
    "ロゼッタ&チコ": "rosalina",
    "リトル・マック": "little_mac",
    "ゲッコウガ": "greninja",
    "Miiファイター(格闘型)": "mii_brawler",
    "Miiファイター(剣術型)": "mii_swordfighter",
    "Miiファイター(射撃型)": "mii_gunner",
    "パルテナ": "palutena",
    "パックマン": "pac_man",
    "ルフレ": "robin",
    "シュルク": "shulk",
    "クッパJr.": "bowser_jr",
    "ダックハント": "duck_hunt",
    "リュウ": "ryu",
    "ケン": "ken",
    "クラウド": "cloud",
    "カムイ": "corrin",
    "ベヨネッタ": "bayonetta",
    "インクリング": "inkling",
    "リドリー": "ridley",
    "シモン": "simon",
    "リヒター": "richter",
    "キングクルール": "king_k_rool",
    "しずえ": "isabelle",
    "ガオガエン": "incineroar",
    "パックンフラワー": "piranha_plant",
    "ジョーカー": "joker",
    "勇者": "hero",
    "バンジョー&カズーイ": "banjo_kazooie",
    "テリー": "terry",
    "ベレト/ベレス": "byleth",
    "ミェンミェン": "min_min",
    "スティーブ": "steve",
    "セフィロス": "sephiroth",
    "ホムラ/ヒカリ": "pyra_mythra",
    "カズヤ": "kazuya",
    "ソラ": "sora",
}

BY_NAME: dict[str, Fighter] = {f.name: f for f in FIGHTERS}


def resolve(query: str) -> list[Fighter]:
    """名前の文字列からファイターを探す。完全一致があればそれだけを返す。

    「マリオ」でドクターマリオまで巻き込まれないようにするための処理。
    """
    q = _normalize(query)
    if not q:
        return []
    exact = [f for f in FIGHTERS if _normalize(f.name) == q or _normalize(f.short) == q]
    if exact:
        return exact
    return [f for f in FIGHTERS if f.matches(query)]


def pool(include_dlc: bool = True, include_echo: bool = True,
         include_mii: bool = False, exclude: list[str] | None = None) -> list[Fighter]:
    """条件に合うファイターの抽選候補を返す。Miiファイターは既定で除外。"""
    excluded: set[str] = set()
    for query in exclude or []:
        excluded.update(f.name for f in resolve(query))

    result = []
    for f in FIGHTERS:
        if not include_dlc and f.dlc:
            continue
        if not include_echo and f.echo:
            continue
        if not include_mii and f.is_mii:
            continue
        if f.name in excluded:
            continue
        result.append(f)
    return result


def unknown_queries(exclude: list[str]) -> list[str]:
    """どのファイターにも当たらなかった除外ワードを返す。"""
    return [q for q in exclude if not resolve(q)]


def parse_exclude(text: str | None) -> list[str]:
    """「マリオ, ルイージ / クッパ」のような入力をリストにする。"""
    if not text:
        return []
    for sep in ("、", "，", "/", "／", "|", " ", "　"):
        text = text.replace(sep, ",")
    return [part.strip() for part in text.split(",") if part.strip()]
