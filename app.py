import argparse
import hashlib
import json
import logging
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory

BASE = Path(__file__).resolve().parent
DATA = Path.home() / ".playlist-cutter"
PROJECTS = DATA / "projects"
WORK = DATA / "work"
SRC = WORK / "src"
CLIPS = WORK / "clips"
SHARED_DOWNLOADS = Path.home() / "storage" / "downloads"
OUTPUT = SHARED_DOWNLOADS / "PlaylistCutter" if SHARED_DOWNLOADS.is_dir() else DATA / "output"

QUALITIES = {360, 480, 720, 1080}
FRAME = {360: (640, 360), 480: (854, 480), 720: (1280, 720), 1080: (1920, 1080)}
VIDEO_ID = re.compile(r"^[\w-]{6,20}$")
UNSAFE = re.compile(r"[^\w\- .()]+")
YTDLP_PCT = re.compile(r"^\[download\]\s+([\d.]+)%")
FFMPEG_TIME = re.compile(r"time=(\d+):(\d+):([\d.]+)")
SB_API = "https://sponsor.ajay.app/api/skipSegments"
FFMPEG = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1"]
PRE_ROLL = 5.0
CLIP_VERSION = "2"

app = Flask(__name__, static_folder=str(BASE / "static"), static_url_path="/static")
JOB = None
JOB_LOCK = threading.Lock()


def which(cmd):
    return shutil.which(cmd) is not None


def run_quiet(cmd, timeout=20):
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        pass


def set_wake_lock(on):
    cmd = "termux-wake-lock" if on else "termux-wake-unlock"
    if which(cmd):
        run_quiet([cmd])


def clean_name(raw, fallback):
    name = UNSAFE.sub("", str(raw or "")).strip(" .")[:80]
    return name or fallback


def unique_path(path):
    if not path.exists():
        return path
    n = 2
    while (candidate := path.with_name(f"{path.stem} ({n}){path.suffix}")).exists():
        n += 1
    return candidate


def find_file(folder, prefix):
    return next((p for p in folder.glob(f"{prefix}*.mp4") if p.is_file()), None)


def probe(path, entries):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", entries, "-of", "json", str(path)],
        capture_output=True, text=True, timeout=60,
    )
    return json.loads(out.stdout or "{}")


def probe_duration(path):
    return float(probe(path, "format=duration").get("format", {}).get("duration") or 0)


def has_audio(path):
    return any(s.get("codec_type") == "audio" for s in probe(path, "stream=codec_type").get("streams", []))


def stream_durations(path):
    streams = probe(path, "stream=codec_type,duration").get("streams", [])
    return {s["codec_type"]: float(s["duration"]) for s in streams if s.get("duration") not in (None, "N/A")}


def next_keyframe(path, start):
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
            "-read_intervals", f"{start:.3f}%+30", "-show_entries", "frame=best_effort_timestamp_time",
            "-of", "csv=p=0", str(path),
        ],
        capture_output=True, text=True, timeout=120,
    ).stdout
    times = sorted(float(t) for t in out.split() if t.replace(".", "", 1).isdigit())
    return next((t for t in times if t >= start - 0.001), start)


def stream_signature(path):
    streams = probe(path, "stream=codec_type,codec_name,width,height,sample_rate,channels").get("streams", [])
    return tuple(sorted(tuple(sorted((k, str(v)) for k, v in s.items())) for s in streams))


def ffmeta_escape(text):
    return re.sub(r"([=;#\\])", r"\\\1", re.sub(r"\s+", " ", text))


def chapters_file(titles, durations):
    lines, start = [";FFMETADATA1"], 0
    for title, duration in zip(titles, durations):
        end = start + int(duration * 1000)
        lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={start}", f"END={end}", f"title={ffmeta_escape(title)}"]
        start = end
    return "\n".join(lines) + "\n"


def clip_key(video, spec):
    raw = f"{CLIP_VERSION}|{video['id']}|{spec['quality']}|{spec['mode']}|{spec['dataSaver']}|{video['start']:.3f}|{video['end']:.3f}"
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def download_progress(line, length):
    match = YTDLP_PCT.match(line)
    if match:
        return min(float(match.group(1)), 100.0)
    match = FFMPEG_TIME.search(line)
    if match and length:
        h, m, s = match.groups()
        return min((int(h) * 3600 + int(m) * 60 + float(s)) / length * 100, 100.0)
    return None


def precise_cut_cmd(source, start, length, quality, out):
    seek = max(start - PRE_ROLL, 0.0)
    offset = start - seek
    w, h = FRAME[quality]
    window = f"start={offset:.3f}:duration={length:.3f}"
    video = (
        f"[0:v:0]trim={window},setpts=PTS-STARTPTS,"
        f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v]"
    )
    if has_audio(source):
        audio = (
            f"[0:a:0]atrim={window},asetpts=PTS-STARTPTS,aresample=44100,"
            f"aformat=channel_layouts=stereo,apad=whole_dur={length:.3f}[a]"
        )
    else:
        audio = f"anullsrc=r=44100:cl=stereo,atrim=duration={length:.3f}[a]"
    return [
        *FFMPEG, "-ss", f"{seek:.3f}", "-i", str(source), "-filter_complex", f"{video};{audio}",
        "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k", "-f", "mpegts", str(out),
    ]


def ffmpeg_reader(length, set_pct):
    def on_line(line):
        key, sep, value = line.partition("=")
        if not sep or " " in key.strip():
            return False
        if key == "out_time_us" and value.strip().isdigit() and length > 0:
            set_pct(min(100.0, int(value) / 1e6 / length * 100))
        return True
    return on_line


class Cancelled(Exception):
    pass


class Job:
    def __init__(self, spec):
        self.spec = spec
        self.status = "running"
        self.phase = "Starting"
        self.items = [{"id": v["id"], "title": v["title"], "state": "pending", "progress": 0.0} for v in spec["videos"]]
        self.merge_progress = 0.0
        self.log = []
        self.warnings = []
        self.error = None
        self.output = None
        self.proc = None
        self.cancelled = False
        self.started = time.time()
        self.finished = None

    def snapshot(self):
        items_avg = sum(i["progress"] for i in self.items) / max(len(self.items), 1)
        return {
            "status": self.status,
            "phase": self.phase,
            "items": self.items,
            "overall": round(items_avg * 0.9 + self.merge_progress * 0.1, 1),
            "log": self.log[-150:],
            "warnings": self.warnings,
            "error": self.error,
            "output": Path(self.output).name if self.output else None,
            "outputPath": self.output,
            "elapsed": int((self.finished or time.time()) - self.started),
        }

    def add_log(self, line):
        self.log.append(line)
        if len(self.log) > 400:
            del self.log[:-300]

    def cancel(self):
        self.cancelled = True
        proc = self.proc
        if proc and proc.poll() is None:
            proc.terminate()

    def execute(self, cmd, on_line):
        if self.cancelled:
            raise Cancelled
        self.proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, errors="replace",
        )
        tail = []
        for raw in self.proc.stdout:
            line = raw.strip()
            if not line or on_line(line):
                continue
            tail = (tail + [line])[-5:]
            self.add_log(line)
        code = self.proc.wait()
        self.proc = None
        if self.cancelled:
            raise Cancelled
        if code != 0:
            raise RuntimeError(tail[-1] if tail else f"{cmd[0]} exited with code {code}")

    def run(self):
        set_wake_lock(True)
        try:
            for folder in (SRC, CLIPS, OUTPUT):
                folder.mkdir(parents=True, exist_ok=True)
            clips = [self.prepare(i, v) for i, v in enumerate(self.spec["videos"])]
            self.merge(clips)
            if not self.spec["keepFiles"]:
                shutil.rmtree(WORK, ignore_errors=True)
            self.status, self.phase = "done", "Done"
        except Cancelled:
            self.status, self.phase = "cancelled", "Cancelled"
        except Exception as exc:
            self.status, self.phase, self.error = "error", "Failed", str(exc) or exc.__class__.__name__
        finally:
            self.finished = time.time()
            set_wake_lock(False)

    def prepare(self, index, video):
        item = self.items[index]
        ext = "ts" if self.spec["mode"] == "precise" else "mp4"
        clip = CLIPS / f"{clip_key(video, self.spec)}.{ext}"
        self.phase = f"Video {index + 1} of {len(self.items)}"
        if clip.exists():
            item.update(state="done", progress=100.0)
            return clip, video
        if self.spec["dataSaver"]:
            self.download_section(item, video, clip)
        else:
            self.cut(item, video, self.download_full(item, video), clip)
        item.update(state="done", progress=100.0)
        return clip, video

    def ytdlp(self, video, template, item, share, length=None, extra=()):
        q = self.spec["quality"]
        fmt = f"bv*[height<={q}][vcodec^=avc1]+ba[ext=m4a]/b[height<={q}][ext=mp4]/bv*[height<={q}]+ba/b[height<={q}]/b"
        cmd = [
            "yt-dlp", "--no-playlist", "--newline", "--no-warnings", "-f", fmt,
            "--merge-output-format", "mp4", "--remux-video", "mp4", "-o", str(template), *extra,
            f"https://www.youtube.com/watch?v={video['id']}",
        ]

        def on_line(line):
            pct = download_progress(line, length)
            if pct is None:
                return False
            item["progress"] = round(share * pct / 100, 1)
            return True

        self.execute(cmd, on_line)

    def download_full(self, item, video):
        prefix = f"{video['id']}_{self.spec['quality']}"
        share = 90 if self.spec["mode"] == "fast" else 40
        source = find_file(SRC, prefix)
        if source:
            item["progress"] = float(share)
            return source
        item["state"] = "downloading"
        self.ytdlp(video, SRC / f"{prefix}.%(ext)s", item, share)
        source = find_file(SRC, prefix)
        if not source:
            raise RuntimeError(f"Download produced no file for {video['title']}")
        return source

    def download_section(self, item, video, clip):
        item["state"] = "downloading"
        prefix = f"{clip.stem}.tmp"
        section = f"*{video['start']:.3f}-{video['end']:.3f}"
        self.ytdlp(video, CLIPS / f"{prefix}.%(ext)s", item, 100, video["end"] - video["start"], ["--download-sections", section])
        tmp = find_file(CLIPS, prefix)
        if not tmp:
            raise RuntimeError(f"Section download produced no file for {video['title']}")
        tmp.replace(clip)

    def cut(self, item, video, source, clip):
        item["state"] = "cutting"
        fast = self.spec["mode"] == "fast"
        base = 90 if fast else 40
        length = video["end"] - video["start"]
        tmp = clip.with_name(f"{clip.stem}.tmp{clip.suffix}")
        if fast:
            keyframe = next_keyframe(source, video["start"])
            length = max(video["end"] - keyframe, 1.0)
            cmd = [
                *FFMPEG, "-ss", f"{keyframe:.3f}", "-i", str(source), "-t", f"{length:.3f}",
                "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-avoid_negative_ts", "make_zero",
                "-movflags", "+faststart", str(tmp),
            ]
        else:
            cmd = precise_cut_cmd(source, video["start"], length, self.spec["quality"], tmp)

        def set_pct(pct):
            item["progress"] = round(base + (100 - base) * pct / 100, 1)

        self.execute(cmd, ffmpeg_reader(length, set_pct))
        tmp.replace(clip)

    def check_sync(self, path, expected):
        durations = stream_durations(path)
        audio, picture = durations.get("audio"), durations.get("video")
        if audio is None or picture is None:
            return
        if abs(audio - picture) > 0.25 or abs(picture - expected) > 0.25:
            self.warnings.append(
                f"Merged video is {picture:.2f} s with {audio:.2f} s of audio, expected {expected:.2f} s. Sound may be out of sync."
            )

    def merge(self, clips):
        self.phase = "Merging"
        paths = [path for path, _ in clips]
        if self.spec["mode"] == "fast" and len({stream_signature(p) for p in paths}) > 1:
            self.warnings.append("Some videos differ in resolution or audio format. If the merged video glitches, process again in Precise mode.")
        precise = self.spec["mode"] == "precise"
        if precise:
            durations = [v["end"] - v["start"] for _, v in clips]
            entries = [f"file '{p}'\nduration {d:.6f}\n" for p, d in zip(paths, durations)]
        else:
            durations = [probe_duration(p) for p in paths]
            entries = [f"file '{p}'\n" for p in paths]
        concat = WORK / "concat.txt"
        concat.write_text("".join(entries), encoding="utf-8")
        cmd = [*FFMPEG, "-f", "concat", "-safe", "0", "-i", str(concat)]
        if self.spec["chapters"]:
            meta = WORK / "chapters.txt"
            meta.write_text(chapters_file([v["title"] for _, v in clips], durations), encoding="utf-8")
            cmd += ["-i", str(meta), "-map_metadata", "1", "-map_chapters", "1"]
        tmp = WORK / "merged.tmp.mp4"
        cmd += ["-map", "0", "-c", "copy"]
        if precise:
            cmd += ["-bsf:a", "aac_adtstoasc"]
        cmd += ["-movflags", "+faststart", "-f", "mp4", str(tmp)]

        def set_pct(pct):
            self.merge_progress = round(pct, 1)

        self.execute(cmd, ffmpeg_reader(sum(durations), set_pct))
        if precise:
            self.check_sync(tmp, sum(durations))
        out = unique_path(OUTPUT / f"{self.spec['output']}.mp4")
        shutil.move(str(tmp), str(out))
        self.output = str(out)
        self.merge_progress = 100.0
        if which("termux-media-scan"):
            run_quiet(["termux-media-scan", str(out)])


def validate_spec(data):
    if not isinstance(data, dict):
        return None, "Invalid request"
    videos = []
    for v in data.get("videos") or []:
        try:
            vid, start, end = str(v["id"]), float(v["start"]), float(v["end"])
        except (KeyError, TypeError, ValueError):
            return None, "Invalid video entry"
        if not VIDEO_ID.match(vid) or start < 0 or end - start < 1:
            return None, f"Invalid cut for video {vid}"
        videos.append({"id": vid, "title": str(v.get("title") or vid)[:300], "start": start, "end": end})
    if not videos:
        return None, "No videos to process"
    try:
        quality = int(data.get("quality", 720))
    except (TypeError, ValueError):
        quality = 0
    if quality not in QUALITIES:
        return None, "Invalid quality"
    mode = data.get("mode")
    if mode not in ("fast", "precise"):
        return None, "Invalid mode"
    return {
        "videos": videos,
        "quality": quality,
        "mode": mode,
        "dataSaver": bool(data.get("dataSaver")) and mode == "fast",
        "chapters": bool(data.get("chapters", True)),
        "keepFiles": bool(data.get("keepFiles")),
        "output": clean_name(data.get("output"), "merged"),
    }, None


def sponsorblock_lookup(video_id):
    query = urllib.parse.urlencode({"videoID": video_id, "categories": json.dumps(["intro", "outro"])})
    try:
        with urllib.request.urlopen(f"{SB_API}?{query}", timeout=15) as resp:
            segments = json.load(resp)
    except urllib.error.HTTPError as exc:
        return video_id, ({"intro": None, "outro": None} if exc.code == 404 else None)
    except (urllib.error.URLError, TimeoutError, ValueError):
        return video_id, None
    intros = sorted((s["segment"] for s in segments if s.get("category") == "intro"), key=lambda s: s[0])
    outros = sorted((s["segment"] for s in segments if s.get("category") == "outro"), key=lambda s: s[0])
    return video_id, {"intro": intros[0] if intros else None, "outro": outros[-1] if outros else None}


def project_path(name):
    return PROJECTS / f"{clean_name(name, '') or abort(400)}.json"


@app.get("/")
def index():
    return send_from_directory(BASE / "static", "index.html")


@app.post("/api/playlist")
def playlist():
    url = str((request.get_json(silent=True) or {}).get("url", "")).strip()
    if not url:
        return jsonify(error="Paste a playlist URL first"), 400
    try:
        proc = subprocess.run(
            ["yt-dlp", "--flat-playlist", "-J", "--no-warnings", url],
            capture_output=True, text=True, timeout=180,
        )
    except subprocess.TimeoutExpired:
        return jsonify(error="YouTube took too long to answer. Try again."), 504
    if proc.returncode != 0:
        lines = [l for l in proc.stderr.splitlines() if l.strip()]
        return jsonify(error=lines[-1] if lines else "yt-dlp could not read this URL"), 502
    data = json.loads(proc.stdout)
    entries = data.get("entries") or [data]
    videos = [
        {
            "index": i,
            "id": e["id"],
            "title": e.get("title") or e["id"],
            "duration": e.get("duration"),
            "thumb": f"https://i.ytimg.com/vi/{e['id']}/mqdefault.jpg",
        }
        for i, e in enumerate(entries, 1)
        if e and e.get("id")
    ]
    return jsonify(title=data.get("title") or "Playlist", videos=videos)


@app.post("/api/sponsorblock")
def sponsorblock():
    ids = [i for i in (request.get_json(silent=True) or {}).get("ids", []) if isinstance(i, str) and VIDEO_ID.match(i)]
    with ThreadPoolExecutor(8) as pool:
        return jsonify(dict(pool.map(sponsorblock_lookup, ids[:500])))


@app.get("/api/projects")
def list_projects():
    files = sorted(PROJECTS.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    return jsonify([p.stem for p in files])


@app.get("/api/projects/<name>")
def load_project(name):
    path = project_path(name)
    if not path.exists():
        abort(404)
    return jsonify(json.loads(path.read_text(encoding="utf-8")))


@app.put("/api/projects/<name>")
def save_project(name):
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        abort(400)
    project_path(name).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return jsonify(ok=True)


@app.delete("/api/projects/<name>")
def delete_project(name):
    project_path(name).unlink(missing_ok=True)
    return jsonify(ok=True)


@app.post("/api/process")
def process():
    global JOB
    spec, error = validate_spec(request.get_json(silent=True))
    if error:
        return jsonify(error=error), 400
    with JOB_LOCK:
        if JOB and JOB.status == "running":
            return jsonify(error="A video is already being processed"), 409
        JOB = Job(spec)
        threading.Thread(target=JOB.run, daemon=True).start()
    return jsonify(JOB.snapshot())


@app.get("/api/job")
def job_status():
    return jsonify(JOB.snapshot() if JOB else {"status": "idle"})


@app.post("/api/job/cancel")
def job_cancel():
    if JOB and JOB.status == "running":
        JOB.cancel()
    return jsonify(ok=True)


@app.post("/api/open")
def open_output():
    if not JOB or not JOB.output or not which("termux-open"):
        return jsonify(error="No video to open"), 404
    subprocess.Popen(["termux-open", JOB.output], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return jsonify(ok=True)


@app.get("/output/<path:name>")
def output_file(name):
    return send_from_directory(OUTPUT, name)


def main():
    parser = argparse.ArgumentParser(description="Playlist Cutter")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    missing = [c for c in ("yt-dlp", "ffmpeg", "ffprobe") if not which(c)]
    if missing:
        raise SystemExit(f"Missing tools: {', '.join(missing)}. Run install.sh first.")
    for folder in (PROJECTS, SRC, CLIPS, OUTPUT):
        folder.mkdir(parents=True, exist_ok=True)
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    print(f"Playlist Cutter is running at http://localhost:{args.port}  (Ctrl+C to stop)")
    app.run(host="127.0.0.1", port=args.port, threaded=True)


if __name__ == "__main__":
    main()
