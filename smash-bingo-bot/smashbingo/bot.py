"""スマブラ キャラビンゴ Discord ボット。

必要な環境変数:
    DISCORD_TOKEN  ボットのトークン
    GUILD_ID       （任意）このサーバーにだけ即時にコマンドを登録する
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands

from .bingo import Card, NotEnoughFighters
from .fighters import FIGHTERS, parse_exclude, pool, unknown_queries
from .render import FontNotFound, render_card
from .storage import CardStore

log = logging.getLogger("smashbingo")

ROOT = Path(__file__).resolve().parent.parent
STORE = CardStore(ROOT / "data" / "cards.json")

MAX_SIZE, MIN_SIZE = 5, 3


# ---------------------------------------------------------------- 表示まわり
async def card_file(card: Card) -> discord.File:
    png = await asyncio.to_thread(render_card, card)
    return discord.File(io.BytesIO(png), filename=f"bingo_{card.id}.png")


def card_text(card: Card) -> str:
    done = len(card.completed_lines())
    who = "みんなで" if card.anyone else f"<@{card.owner_id}> 専用"
    head = f"**スマブラ キャラビンゴ** {card.size}×{card.size}・{who}"
    if card.is_full():
        return f"{head}\n🎉 **全マス制覇！ {done}ライン**"
    if done:
        return f"{head}\n🎉 **{done} ビンゴ！**（リーチ {card.reach_count()}）"
    return f"{head}\nマスを押すとマークできます。（リーチ {card.reach_count()}）"


class CellButton(discord.ui.Button):
    def __init__(self, card: Card, index: int):
        name = card.cells[index]
        marked = index in card.marked
        super().__init__(
            label=_button_label(card, index),
            style=discord.ButtonStyle.danger if marked else discord.ButtonStyle.secondary,
            row=index // card.size,
            custom_id=f"sb:{card.id}:{index}",
        )
        self.card_id = card.id
        self.index = index

    async def callback(self, interaction: discord.Interaction) -> None:
        card = STORE.get(self.card_id)
        if card is None:
            await interaction.response.send_message(
                "このカードの記録が残っていません。`/bingo` で新しく作ってください。",
                ephemeral=True)
            return
        if not card.can_mark(interaction.user.id):
            await interaction.response.send_message(
                f"これは <@{card.owner_id}> のカードです。"
                "`/bingo` で自分のカードを作るか、`みんなで:True` で作り直してもらってください。",
                ephemeral=True)
            return

        before = len(card.completed_lines())
        card.toggle(self.index)
        after = len(card.completed_lines())
        STORE.save()

        view = BingoView(card)
        await interaction.response.edit_message(
            content=card_text(card), attachments=[await card_file(card)], view=view)
        if after > before:
            msg = "🎉 **全マス制覇！**" if card.is_full() else f"🎉 **{after} ビンゴ！**"
            await interaction.followup.send(f"{interaction.user.mention} {msg}")


def _button_label(card: Card, index: int) -> str:
    from .fighters import BY_NAME
    name = card.cells[index]
    if index == card.free_index:
        return "FREE"
    fighter = BY_NAME.get(name)
    label = fighter.short if fighter else name
    return label[:12] if len(label) > 12 else label


class BingoView(discord.ui.View):
    def __init__(self, card: Card):
        super().__init__(timeout=None)
        for index in range(card.size * card.size):
            button = CellButton(card, index)
            if index == card.free_index:
                button.disabled = True
                button.style = discord.ButtonStyle.success
            self.add_item(button)


# ---------------------------------------------------------------- ボット
class BingoBot(commands.Bot):
    def __init__(self) -> None:
        super().__init__(command_prefix="!sb ", intents=discord.Intents.default())

    async def setup_hook(self) -> None:
        # 再起動前のカードのボタンを生かしておく
        for card in STORE.cards.values():
            if card.message_id:
                self.add_view(BingoView(card), message_id=card.message_id)

        guild_id = os.environ.get("GUILD_ID")
        if guild_id:
            guild = discord.Object(id=int(guild_id))
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
            log.info("サーバー %s にコマンドを登録しました", guild_id)
        else:
            await self.tree.sync()
            log.info("コマンドをグローバルに登録しました（反映に時間がかかります）")

    async def on_ready(self) -> None:
        log.info("ログインしました: %s", self.user)


bot = BingoBot()


async def post_card(interaction: discord.Interaction, card: Card) -> None:
    """カードを投稿して、あとからボタンを押せるように記録しておく。"""
    message = await interaction.followup.send(
        content=card_text(card), file=await card_file(card),
        view=BingoView(card), wait=True)
    card.message_id = message.id
    card.channel_id = interaction.channel_id
    STORE.add(card)


@bot.tree.command(name="bingo", description="スマブラのキャラでビンゴカードを作ります")
@app_commands.describe(
    マス="1辺のマス数（3〜5、既定は5）",
    追加ファイター="パックンフラワー以降のDLCを入れる（既定: 入れる）",
    ダッシュファイター="ルキナ・クロム・ケンなどを入れる（既定: 入れる）",
    mii="Miiファイター3種を入れる（既定: 入れない）",
    まんなかfree="中央をFREEマスにする（既定: しない）",
    除外="入れたくないキャラ。例: マリオ, カズヤ, ソラ",
    みんなで="他の人もマークできるようにする（既定: 作った人だけ）",
    seed="同じ文字を入れると同じカードが出ます",
)
async def bingo(
    interaction: discord.Interaction,
    マス: app_commands.Range[int, MIN_SIZE, MAX_SIZE] = 5,
    追加ファイター: bool = True,
    ダッシュファイター: bool = True,
    mii: bool = False,
    まんなかfree: bool = False,
    除外: str | None = None,
    みんなで: bool = False,
    seed: str | None = None,
) -> None:
    await interaction.response.defer()
    excludes = parse_exclude(除外)
    try:
        card = Card.create(
            owner_id=interaction.user.id,
            owner_name=interaction.user.display_name,
            size=マス,
            free=まんなかfree,
            include_dlc=追加ファイター,
            include_echo=ダッシュファイター,
            include_mii=mii,
            exclude=excludes,
            seed=seed,
            anyone=みんなで,
        )
    except NotEnoughFighters as err:
        await interaction.followup.send(
            f"候補が足りません（必要 {err.needed}マス / 候補 {err.available}体）。"
            "除外を減らすか、マス数を小さくしてください。", ephemeral=True)
        return
    except FontNotFound as err:
        await interaction.followup.send(str(err), ephemeral=True)
        return

    await post_card(interaction, card)

    unknown = unknown_queries(excludes)
    if unknown:
        await interaction.followup.send(
            "次の除外ワードはどのファイターにも当たりませんでした: "
            + "、".join(unknown), ephemeral=True)


@bot.tree.command(name="reroll", description="同じ設定でカードを引き直します")
async def reroll(interaction: discord.Interaction) -> None:
    await interaction.response.defer()
    card = STORE.latest_for(interaction.user.id, interaction.channel_id)
    if card is None:
        await interaction.followup.send(
            "このチャンネルにあなたのカードがありません。`/bingo` で作ってください。",
            ephemeral=True)
        return
    await post_card(interaction, card.reroll())


@bot.tree.command(name="reset", description="いまのカードのマークを全部消します")
async def reset(interaction: discord.Interaction) -> None:
    card = STORE.latest_for(interaction.user.id, interaction.channel_id)
    if card is None:
        await interaction.response.send_message(
            "このチャンネルにあなたのカードがありません。", ephemeral=True)
        return
    card.clear()
    STORE.save()
    await interaction.response.defer()
    if card.message_id and interaction.channel:
        try:
            message = await interaction.channel.fetch_message(card.message_id)
            await message.edit(content=card_text(card),
                               attachments=[await card_file(card)],
                               view=BingoView(card))
            await interaction.followup.send("マークを消しました。", ephemeral=True)
            return
        except discord.HTTPException:
            pass
    await post_card(interaction, card)


@bot.tree.command(name="fighters", description="抽選に使えるファイターの一覧を出します")
@app_commands.describe(
    追加ファイター="DLCを含める（既定: 含める）",
    ダッシュファイター="ダッシュファイターを含める（既定: 含める）",
    mii="Miiファイターを含める（既定: 含めない）",
)
async def fighters_command(
    interaction: discord.Interaction,
    追加ファイター: bool = True,
    ダッシュファイター: bool = True,
    mii: bool = False,
) -> None:
    candidates = pool(include_dlc=追加ファイター, include_echo=ダッシュファイター,
                      include_mii=mii)
    names = "、".join(f.name for f in candidates)
    embed = discord.Embed(
        title=f"抽選候補 {len(candidates)}体 / 全{len(FIGHTERS)}体",
        description=names[:4000],
        color=0xE23E48,
    )
    no_icon = [f.name for f in candidates if not f.icon_id]
    if no_icon:
        embed.set_footer(text="画像がないキャラ（名前だけ表示）: " + "、".join(no_icon))
    await interaction.response.send_message(embed=embed, ephemeral=True)


@bot.tree.command(name="bingohelp", description="このボットの使い方")
async def bingohelp(interaction: discord.Interaction) -> None:
    embed = discord.Embed(title="スマブラ キャラビンゴの使い方", color=0xF7C74A)
    embed.add_field(
        name="/bingo",
        value="カードを作ります。マス数・DLC・除外キャラ・seed などを指定できます。\n"
              "既定は 5×5、FREEマスなし、Miiファイターなし。",
        inline=False)
    embed.add_field(name="/reroll", value="同じ設定で引き直します。", inline=False)
    embed.add_field(name="/reset", value="マークを全部消します。", inline=False)
    embed.add_field(name="/fighters", value="抽選候補のキャラ一覧を出します。", inline=False)
    embed.add_field(
        name="マークのしかた",
        value="カードの下のボタンを押すと、そのマスに赤い丸がつきます。"
              "もう一度押すと外れます。そろうと自動でビンゴを知らせます。",
        inline=False)
    await interaction.response.send_message(embed=embed, ephemeral=True)


def main() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    token = os.environ.get("DISCORD_TOKEN")
    if not token:
        raise SystemExit(
            "環境変数 DISCORD_TOKEN が設定されていません。"
            ".env.example を参考に .env を作ってください。")
    bot.run(token)


if __name__ == "__main__":
    main()
