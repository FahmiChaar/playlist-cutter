import json
import subprocess
import sys
import time
import urllib.request

PORT = sys.argv[1]
START, END = 3.37, 21.81


def call(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"http://localhost:{PORT}{path}", data=data,
        headers={"Content-Type": "application/json"}, method="POST" if data else "GET",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def run_job(videos, **options):
    call("/api/process", {"videos": videos, "quality": 720, "chapters": True, **options})
    deadline = time.time() + 600
    while (job := call("/api/job"))["status"] == "running":
        if time.time() > deadline:
            raise SystemExit("Job timed out")
        time.sleep(1)
    if job["status"] != "done":
        raise SystemExit(f"Job failed: {job.get('error')}\n" + "\n".join(job["log"][-20:]))
    return job


def streams(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", path],
        capture_output=True, text=True, check=True,
    ).stdout
    return {s["codec_type"]: float(s["duration"]) for s in json.loads(out)["streams"] if s["codec_type"] in ("audio", "video")}


def chapters(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "chapter=start_time", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True,
    ).stdout
    return [float(x) for x in out.split()]


def main():
    playlist = call("/api/playlist", {"url": "https://www.youtube.com/playlist?list=TEST"})
    videos = [{"id": v["id"], "title": v["title"], "start": START, "end": END} for v in playlist["videos"]]
    expected = len(videos) * (END - START)

    job = run_job(videos, mode="precise", output="precise")
    found = streams(job["outputPath"])
    print(f"precise: video {found['video']:.3f} s, audio {found['audio']:.3f} s, expected {expected:.3f} s")
    assert abs(found["video"] - expected) < 0.1, "precise video length drifted"
    assert abs(found["audio"] - expected) < 0.1, "precise audio length drifted"
    assert not job["warnings"], job["warnings"]
    marks = chapters(job["outputPath"])
    assert len(marks) == len(videos), "missing chapters"
    assert all(abs(m - i * (END - START)) < 0.01 for i, m in enumerate(marks)), "chapters misaligned"

    same_format = [videos[i] for i in (0, 4, 6)]
    limit = len(same_format) * (END - START)
    job = run_job(same_format, mode="fast", output="fast")
    found = streams(job["outputPath"])
    print(f"fast: video {found['video']:.3f} s, audio {found['audio']:.3f} s, at most {limit:.3f} s")
    assert found["video"] <= limit + 0.1, "fast mode kept content before the start time"
    assert abs(found["audio"] - found["video"]) < 0.15, "fast mode audio out of sync"

    job = run_job(videos[:2], mode="fast", dataSaver=True, output="saver")
    print(f"data saver: {streams(job['outputPath'])}")
    print("All checks passed")


main()
