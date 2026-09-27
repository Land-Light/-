import json
import shutil
import subprocess
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import archiver


def make_config(tmp: Path, **overrides) -> archiver.Config:
    env = {"DATA_DIR": str(tmp), "POLL_INTERVAL": "0", "RECONNECT_GRACE": "0"}
    with mock.patch.dict("os.environ", env, clear=True):
        cfg = archiver.Config.from_env()
    for k, v in overrides.items():
        setattr(cfg, k, v)
    cfg.recordings_dir.mkdir(parents=True, exist_ok=True)
    cfg.queue_dir.mkdir(parents=True, exist_ok=True)
    return cfg


def make_video(path: Path, seconds: int) -> None:
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc=size=160x90:rate=10:duration={seconds}",
         "-f", "lavfi", "-i", f"sine=duration={seconds}",
         "-c:v", "libx264", "-g", "10", "-c:a", "aac", "-f", "mpegts", str(path)],
        check=True,
    )


class VideoTextTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.cfg = make_config(self.tmp)
        self.started = datetime(2026, 9, 26, 15, 30, tzinfo=timezone.utc)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_default_title_uses_japan_date(self):
        title, desc = archiver.build_video_text(
            self.cfg, {"title": "マイクラ <初見>", "category": "Minecraft"}, self.started)
        self.assertEqual(title, "マイクラ 初見 【2026/09/27】")
        self.assertIn("カテゴリ: Minecraft", desc)
        self.assertIn("2026/09/27 00:30", desc)
        self.assertIn("https://www.twitch.tv/paseriman2", desc)

    def test_long_title_is_truncated_with_part_suffix(self):
        title, _ = archiver.build_video_text(self.cfg, {"title": "あ" * 200}, self.started, 2, 3)
        self.assertEqual(len(title), archiver.TITLE_MAX)
        self.assertTrue(title.endswith(" (Part 2/3)"))

    def test_missing_metadata_and_unknown_placeholder(self):
        self.cfg.title_template = "{title} {unknown}"
        title, _ = archiver.build_video_text(self.cfg, {}, self.started)
        self.assertEqual(title, "paseriman2 の配信 {unknown}")


class MonitorLoopTest(unittest.TestCase):
    """回線が切れて再開した配信がひとつの動画にまとまることを確認する。"""

    def test_reconnect_is_merged_into_one_session(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        cfg = make_config(tmp, reconnect_grace=3600)
        stop = threading.Event()
        # 配信中 → (切断) 配信中 → 終了 → 監視停止
        answers = iter([{"title": "A"}, {"title": "B"}, None])

        def fake_check(_cfg):
            try:
                return next(answers)
            except StopIteration:
                stop.set()
                return None

        def fake_record(_cfg, output, _stop):
            output.write_bytes(b"x")

        finalized = []
        with mock.patch.object(archiver, "check_live", fake_check), \
             mock.patch.object(archiver, "record", fake_record), \
             mock.patch.object(archiver, "finalize_session", lambda c, s: finalized.append(s)):
            archiver.monitor_loop(cfg, stop)

        self.assertEqual(len(finalized), 1)
        session = finalized[0]
        self.assertEqual([p.name for p in session.parts],
                         [f"{session.id}_part01.ts", f"{session.id}_part02.ts"])
        self.assertEqual(session.meta["title"], "B")


class CheckLiveTest(unittest.TestCase):
    def run_with_output(self, stdout):
        cfg = make_config(Path(tempfile.mkdtemp()))
        self.addCleanup(shutil.rmtree, cfg.data_dir)
        result = subprocess.CompletedProcess([], 0, stdout=stdout, stderr="")
        with mock.patch.object(archiver.subprocess, "run", return_value=result):
            return archiver.check_live(cfg)

    def test_live(self):
        out = json.dumps({"plugin": "twitch", "streams": {"best": {}},
                          "metadata": {"title": "雑談", "category": "Just Chatting"}})
        self.assertEqual(self.run_with_output(out)["title"], "雑談")

    def test_offline(self):
        out = json.dumps({"error": "No playable streams found on this URL: https://www.twitch.tv/paseriman2"})
        self.assertIsNone(self.run_with_output(out))


class UploadLoopTest(unittest.TestCase):
    def test_successful_upload_removes_job_and_video(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        cfg = make_config(tmp)
        video = cfg.recordings_dir / "s.mp4"
        video.write_bytes(b"x")
        (cfg.queue_dir / "s_01.json").write_text(json.dumps(
            {"id": "s_01", "video": str(video), "title": "t", "description": "d"}), encoding="utf-8")
        stop = threading.Event()

        def fake_upload(_cfg, job):
            stop.set()
            return "abc123"

        with mock.patch.object(archiver, "upload_video", fake_upload):
            archiver.upload_loop(cfg, stop)

        self.assertEqual(list(cfg.queue_dir.iterdir()), [])
        self.assertFalse(video.exists())
        self.assertIn("abc123", (tmp / "uploaded.log").read_text(encoding="utf-8"))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg が必要")
class FinalizeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_parts_are_merged_into_one_mp4_job(self):
        cfg = make_config(self.tmp)
        parts = [cfg.recordings_dir / f"s_part0{i}.ts" for i in (1, 2)]
        for p in parts:
            make_video(p, 3)
        session = archiver.Session(id="s", started_at=datetime.now(timezone.utc),
                                   meta={"title": "テスト"}, parts=parts)
        archiver.finalize_session(cfg, session)

        jobs = list(cfg.queue_dir.glob("*.json"))
        self.assertEqual(len(jobs), 1)
        job = json.loads(jobs[0].read_text(encoding="utf-8"))
        self.assertTrue(job["video"].endswith("s.mp4"))
        self.assertAlmostEqual(archiver.probe_duration(Path(job["video"])), 6, delta=0.5)
        self.assertFalse(any(p.exists() for p in parts))

    def test_long_video_is_split(self):
        cfg = make_config(self.tmp, max_video_hours=4 / 3600)  # 4 秒で分割
        part = cfg.recordings_dir / "s_part01.ts"
        make_video(part, 10)
        session = archiver.Session(id="s", started_at=datetime.now(timezone.utc),
                                   meta={"title": "長い"}, parts=[part])
        archiver.finalize_session(cfg, session)

        jobs = sorted(json.loads(p.read_text(encoding="utf-8"))["title"]
                      for p in cfg.queue_dir.glob("*.json"))
        self.assertEqual(len(jobs), 3)
        self.assertTrue(jobs[0].endswith("(Part 1/3)"))

    def test_leftover_recordings_are_recovered(self):
        cfg = make_config(self.tmp)
        make_video(cfg.recordings_dir / "20260927_010203_paseriman2_part01.ts", 2)
        archiver.recover_leftovers(cfg)
        self.assertEqual(len(list(cfg.queue_dir.glob("*.json"))), 1)


if __name__ == "__main__":
    unittest.main()
