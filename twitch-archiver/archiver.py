#!/usr/bin/env python3
"""Twitch の配信を監視して録画し、終わったら YouTube にアップロードする常駐プログラム。

流れ:
  1. streamlink で配信中かどうかを POLL_INTERVAL 秒ごとに確認する
  2. 配信中なら録画する (回線が切れて再開した場合もひとつの配信としてまとめる)
  3. 配信が RECONNECT_GRACE 秒以上止まったら、録画を ffmpeg で mp4 にまとめて
     アップロード待ちの列 (queue/) に積む
  4. 別スレッドが列を順に YouTube へアップロードする。失敗しても列に残るので、
     再起動後や時間をおいて自動で再試行する
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from pathlib import Path

log = logging.getLogger("archiver")

# YouTube のタイトル・説明文の上限 (文字数) と使えない文字
TITLE_MAX = 100
DESCRIPTION_MAX = 5000
FORBIDDEN_CHARS = "<>"


def env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Config:
    channel: str
    data_dir: Path
    quality: str
    poll_interval: int
    reconnect_grace: int
    timezone_offset: int
    title_template: str
    description_template: str
    tags: list[str]
    privacy: str
    category_id: str
    made_for_kids: bool
    playlist_id: str
    delete_after_upload: bool
    max_video_hours: float
    client_secret: Path
    token_file: Path
    twitch_oauth_token: str
    upload_enabled: bool

    @classmethod
    def from_env(cls) -> "Config":
        data_dir = Path(os.environ.get("DATA_DIR", "./data")).resolve()
        return cls(
            channel=os.environ.get("TWITCH_CHANNEL", "paseriman2").strip().lower(),
            data_dir=data_dir,
            quality=os.environ.get("QUALITY", "best"),
            poll_interval=int(os.environ.get("POLL_INTERVAL", "60")),
            reconnect_grace=int(os.environ.get("RECONNECT_GRACE", "300")),
            timezone_offset=int(os.environ.get("TZ_OFFSET_HOURS", "9")),
            title_template=os.environ.get("TITLE_TEMPLATE", "{title} 【{date}】"),
            description_template=os.environ.get(
                "DESCRIPTION_TEMPLATE",
                "{channel} さんの Twitch 配信のアーカイブです。\n"
                "\n"
                "配信タイトル: {title}\n"
                "カテゴリ: {category}\n"
                "配信日時: {datetime}\n"
                "Twitch: https://www.twitch.tv/{channel}\n",
            ).replace("\\n", "\n"),
            tags=[t.strip() for t in os.environ.get("TAGS", "Twitch,配信アーカイブ").split(",") if t.strip()],
            privacy=os.environ.get("PRIVACY", "private"),
            category_id=os.environ.get("CATEGORY_ID", "20"),  # 20 = Gaming
            made_for_kids=env_bool("MADE_FOR_KIDS", False),
            playlist_id=os.environ.get("PLAYLIST_ID", "").strip(),
            delete_after_upload=env_bool("DELETE_AFTER_UPLOAD", True),
            max_video_hours=float(os.environ.get("MAX_VIDEO_HOURS", "11.5")),
            client_secret=Path(os.environ.get("CLIENT_SECRET_FILE", str(data_dir / "client_secret.json"))),
            token_file=Path(os.environ.get("TOKEN_FILE", str(data_dir / "token.json"))),
            twitch_oauth_token=os.environ.get("TWITCH_OAUTH_TOKEN", "").strip(),
            upload_enabled=env_bool("UPLOAD_ENABLED", True),
        )

    @property
    def url(self) -> str:
        return f"https://www.twitch.tv/{self.channel}"

    @property
    def tz(self) -> timezone:
        return timezone(timedelta(hours=self.timezone_offset))

    @property
    def recordings_dir(self) -> Path:
        return self.data_dir / "recordings"

    @property
    def queue_dir(self) -> Path:
        return self.data_dir / "queue"


# ---------------------------------------------------------------------------
# タイトル・説明文
# ---------------------------------------------------------------------------

def sanitize(text: str) -> str:
    for ch in FORBIDDEN_CHARS:
        text = text.replace(ch, "")
    return text


def truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def render(template: str, values: dict[str, str]) -> str:
    class Default(dict):
        def __missing__(self, key: str) -> str:
            return "{" + key + "}"

    return template.format_map(Default(values))


def build_video_text(cfg: Config, meta: dict, started_at: datetime,
                     part: int | None = None, parts: int | None = None) -> tuple[str, str]:
    local = started_at.astimezone(cfg.tz)
    values = {
        "channel": cfg.channel,
        "title": (meta.get("title") or "").strip() or f"{cfg.channel} の配信",
        "category": (meta.get("category") or "").strip() or "不明",
        "author": (meta.get("author") or cfg.channel).strip(),
        "date": local.strftime("%Y/%m/%d"),
        "datetime": local.strftime("%Y/%m/%d %H:%M"),
    }
    suffix = f" (Part {part}/{parts})" if parts and parts > 1 else ""
    title = sanitize(render(cfg.title_template, values))
    title = truncate(title, TITLE_MAX - len(suffix)) + suffix
    description = truncate(sanitize(render(cfg.description_template, values)), DESCRIPTION_MAX)
    return title, description


# ---------------------------------------------------------------------------
# Twitch 側 (streamlink)
# ---------------------------------------------------------------------------

def streamlink_base_args(cfg: Config) -> list[str]:
    args = ["streamlink"]
    if cfg.twitch_oauth_token:
        args += ["--twitch-api-header", f"Authorization=OAuth {cfg.twitch_oauth_token}"]
    return args


def check_live(cfg: Config) -> dict | None:
    """配信中なら streamlink が返すメタデータ (title, category など) を、そうでなければ None を返す。"""
    try:
        proc = subprocess.run(
            streamlink_base_args(cfg) + ["--json", cfg.url],
            capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        log.warning("配信状態の確認がタイムアウトしました")
        return None
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        log.warning("streamlink の出力を読めませんでした: %s", proc.stdout[:200])
        return None
    if "error" in data:
        if "No playable streams" not in data["error"]:
            log.warning("配信状態の確認に失敗: %s", data["error"])
        return None
    if not data.get("streams"):
        return None
    return data.get("metadata") or {}


def record(cfg: Config, output: Path, stop: threading.Event) -> None:
    """配信が終わる (または切れる) まで録画する。"""
    cmd = streamlink_base_args(cfg) + [
        "--retry-open", "5",
        "--stream-segment-attempts", "5",
        "--hls-live-restart",
        "--loglevel", "warning",
        "--output", str(output),
        cfg.url, cfg.quality,
    ]
    log.info("録画開始: %s", output.name)
    proc = subprocess.Popen(cmd)
    while proc.poll() is None:
        if stop.wait(1):
            proc.send_signal(signal.SIGINT)
            try:
                proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                proc.kill()
            break
    size = output.stat().st_size if output.exists() else 0
    log.info("録画終了: %s (%.1f MB)", output.name, size / 1024 / 1024)


# ---------------------------------------------------------------------------
# 動画ファイルの後処理 (ffmpeg)
# ---------------------------------------------------------------------------

def run_ffmpeg(args: list[str]) -> bool:
    proc = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"] + args,
                          capture_output=True, text=True)
    if proc.returncode != 0:
        log.error("ffmpeg に失敗: %s", proc.stderr.strip()[-1000:])
        return False
    return True


def probe_duration(path: Path) -> float | None:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return None


def merge_parts(parts: list[Path], output: Path) -> bool:
    """録画ファイル (.ts) をひとつの mp4 にまとめる (再エンコードなし)。"""
    if len(parts) == 1:
        return run_ffmpeg(["-i", str(parts[0]), "-c", "copy", "-movflags", "+faststart", str(output)])
    list_file = output.with_suffix(".txt")
    list_file.write_text("".join(f"file '{p.resolve()}'\n" for p in parts), encoding="utf-8")
    try:
        return run_ffmpeg(["-f", "concat", "-safe", "0", "-i", str(list_file),
                           "-c", "copy", "-movflags", "+faststart", str(output)])
    finally:
        list_file.unlink(missing_ok=True)


def split_if_too_long(path: Path, max_hours: float) -> list[Path]:
    """YouTube の上限 (12 時間) を超える動画を分割する。"""
    duration = probe_duration(path)
    limit = max_hours * 3600
    if duration is None or duration <= limit:
        return [path]
    pattern = path.with_name(path.stem + "_%02d.mp4")
    ok = run_ffmpeg(["-i", str(path), "-c", "copy", "-map", "0",
                     "-f", "segment", "-segment_time", str(int(limit)),
                     "-reset_timestamps", "1", str(pattern)])
    pieces = sorted(path.parent.glob(path.stem + "_[0-9][0-9].mp4"))
    if not ok or not pieces:
        return [path]
    path.unlink(missing_ok=True)
    return pieces


# ---------------------------------------------------------------------------
# 録画セッション (途中で切れた配信をひとつにまとめる単位)
# ---------------------------------------------------------------------------

@dataclass
class Session:
    id: str
    started_at: datetime
    meta: dict
    parts: list[Path] = field(default_factory=list)
    last_seen: float = 0.0


def finalize_session(cfg: Config, session: Session) -> None:
    """録画をまとめてアップロード待ちの列に積む。"""
    parts = [p for p in session.parts if p.exists() and p.stat().st_size > 0]
    if not parts:
        log.warning("セッション %s には録画データがありません", session.id)
        return

    merged = cfg.recordings_dir / f"{session.id}.mp4"
    if shutil.which("ffmpeg") and merge_parts(parts, merged):
        for p in parts:
            p.unlink(missing_ok=True)
        videos = split_if_too_long(merged, cfg.max_video_hours)
    else:
        log.warning("mp4 へのまとめに失敗したので、録画ファイルをそのままアップロードします")
        videos = parts

    for i, video in enumerate(videos, start=1):
        title, description = build_video_text(cfg, session.meta, session.started_at, i, len(videos))
        job = {
            "id": f"{session.id}_{i:02d}",
            "video": str(video),
            "title": title,
            "description": description,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        job_path = cfg.queue_dir / f"{job['id']}.json"
        tmp = job_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(job_path)
        log.info("アップロード待ちに追加: %s", title)


def new_session(cfg: Config, meta: dict) -> Session:
    now = datetime.now(timezone.utc)
    sid = now.astimezone(cfg.tz).strftime("%Y%m%d_%H%M%S") + f"_{cfg.channel}"
    log.info("配信を検出: %s / %s", meta.get("title"), meta.get("category"))
    return Session(id=sid, started_at=now, meta=meta)


def monitor_loop(cfg: Config, stop: threading.Event) -> None:
    session: Session | None = None
    log.info("%s の監視を開始 (確認間隔 %d 秒)", cfg.url, cfg.poll_interval)
    while not stop.is_set():
        meta = check_live(cfg)
        if meta is not None:
            if session is None:
                session = new_session(cfg, meta)
            elif meta.get("title"):
                session.meta = meta  # 途中でタイトルが変わったら最新を使う
            part = cfg.recordings_dir / f"{session.id}_part{len(session.parts) + 1:02d}.ts"
            session.parts.append(part)
            record(cfg, part, stop)
            session.last_seen = time.monotonic()
            continue  # すぐにもう一度確認する (回線切れならそのまま続きを録る)

        if session is not None and time.monotonic() - session.last_seen >= cfg.reconnect_grace:
            log.info("配信終了と判断しました")
            finalize_session(cfg, session)
            session = None
        stop.wait(cfg.poll_interval)

    if session is not None:
        log.info("終了前に録画済みの分をアップロード待ちに追加します")
        finalize_session(cfg, session)


# ---------------------------------------------------------------------------
# YouTube へのアップロード
# ---------------------------------------------------------------------------

class QuotaExceeded(Exception):
    pass


def youtube_client(cfg: Config):
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    from youtube_auth import SCOPES

    if not cfg.token_file.exists():
        raise RuntimeError(f"{cfg.token_file} がありません。先に youtube_auth.py で認証してください")
    creds = Credentials.from_authorized_user_file(str(cfg.token_file), SCOPES)
    if not creds.valid:
        creds.refresh(Request())
        cfg.token_file.write_text(creds.to_json(), encoding="utf-8")
    return build("youtube", "v3", credentials=creds, cache_discovery=False)


def upload_video(cfg: Config, job: dict) -> str:
    from googleapiclient.errors import HttpError
    from googleapiclient.http import MediaFileUpload

    youtube = youtube_client(cfg)
    body = {
        "snippet": {
            "title": job["title"],
            "description": job["description"],
            "tags": cfg.tags,
            "categoryId": cfg.category_id,
        },
        "status": {
            "privacyStatus": cfg.privacy,
            "selfDeclaredMadeForKids": cfg.made_for_kids,
        },
    }
    media = MediaFileUpload(job["video"], chunksize=64 * 1024 * 1024, resumable=True)
    request = youtube.videos().insert(part="snippet,status", body=body, media_body=media)

    response = None
    retries = 0
    last_logged = -10
    while response is None:
        try:
            status, response = request.next_chunk()
            retries = 0
            if status:
                pct = int(status.progress() * 100)
                if pct >= last_logged + 10:
                    log.info("アップロード中 %s: %d%%", job["id"], pct)
                    last_logged = pct
        except HttpError as e:
            if e.resp.status == 403 and b"quota" in e.content.lower():
                raise QuotaExceeded() from e
            if e.resp.status not in (500, 502, 503, 504):
                raise
            retries = _backoff(retries, e)
        except (OSError, TimeoutError) as e:
            retries = _backoff(retries, e)

    video_id = response["id"]
    if cfg.playlist_id:
        try:
            youtube.playlistItems().insert(part="snippet", body={
                "snippet": {"playlistId": cfg.playlist_id,
                            "resourceId": {"kind": "youtube#video", "videoId": video_id}},
            }).execute()
        except HttpError as e:
            log.warning("再生リストへの追加に失敗: %s", e)
    return video_id


def _backoff(retries: int, error: Exception) -> int:
    retries += 1
    if retries > 10:
        raise error
    wait = min(2 ** retries, 300)
    log.warning("アップロードでエラー (%s)、%d 秒後に再試行します", error, wait)
    time.sleep(wait)
    return retries


def upload_loop(cfg: Config, stop: threading.Event) -> None:
    while not stop.is_set():
        jobs = sorted(cfg.queue_dir.glob("*.json"))
        if not jobs:
            stop.wait(30)
            continue
        job_path = jobs[0]
        job = json.loads(job_path.read_text(encoding="utf-8"))
        video = Path(job["video"])
        if not video.exists():
            log.error("動画ファイルが見つからないので列から外します: %s", video)
            job_path.rename(job_path.with_suffix(".missing"))
            continue

        log.info("アップロード開始: %s", job["title"])
        try:
            video_id = upload_video(cfg, job)
        except QuotaExceeded:
            log.warning("YouTube API の 1 日の上限に達しました。1 時間後に再試行します")
            stop.wait(3600)
            continue
        except Exception:
            log.exception("アップロードに失敗しました。10 分後に再試行します")
            stop.wait(600)
            continue

        log.info("アップロード完了: https://youtu.be/%s", video_id)
        with (cfg.data_dir / "uploaded.log").open("a", encoding="utf-8") as f:
            f.write(json.dumps({**job, "video_id": video_id,
                                "uploaded_at": datetime.now(timezone.utc).isoformat()},
                               ensure_ascii=False) + "\n")
        job_path.unlink()
        if cfg.delete_after_upload:
            video.unlink(missing_ok=True)


# ---------------------------------------------------------------------------

def recover_leftovers(cfg: Config) -> None:
    """前回の異常終了で残った録画ファイルをアップロード待ちに回す。"""
    queued = {Path(json.loads(p.read_text(encoding="utf-8"))["video"]).name
              for p in cfg.queue_dir.glob("*.json")}
    groups: dict[str, list[Path]] = {}
    for ts in sorted(cfg.recordings_dir.glob("*_part[0-9][0-9].ts")):
        if ts.name not in queued:
            groups.setdefault(ts.name.rsplit("_part", 1)[0], []).append(ts)
    for sid, parts in groups.items():
        log.info("前回の録画が残っていたので処理します: %s", sid)
        started = datetime.strptime(sid[:15], "%Y%m%d_%H%M%S").replace(tzinfo=cfg.tz)
        finalize_session(cfg, Session(id=sid, started_at=started, meta={}, parts=parts))


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s [%(threadName)s] %(levelname)s %(message)s",
    )
    cfg = Config.from_env()
    cfg.recordings_dir.mkdir(parents=True, exist_ok=True)
    cfg.queue_dir.mkdir(parents=True, exist_ok=True)

    for tool in ("streamlink", "ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            log.warning("%s が見つかりません", tool)
    if cfg.upload_enabled and not cfg.token_file.exists():
        log.error("%s がありません。先に `python youtube_auth.py` を実行してください", cfg.token_file)
        return 1

    stop = threading.Event()

    def handle_signal(signum, _frame):
        log.info("停止シグナルを受け取りました")
        stop.set()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    recover_leftovers(cfg)
    if cfg.upload_enabled:
        threading.Thread(target=upload_loop, args=(cfg, stop), name="upload", daemon=True).start()
    else:
        log.info("UPLOAD_ENABLED=false のため録画のみ行います")
    monitor_loop(cfg, stop)
    return 0


if __name__ == "__main__":
    sys.exit(main())
