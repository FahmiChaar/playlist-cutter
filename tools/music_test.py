import argparse
import os
import subprocess
import sys
import time
import types

import numpy as np
import torch


def stub_dora():
    log = types.ModuleType("dora.log")
    log.fatal = lambda *args: sys.exit(" ".join(map(str, args)))
    log.bold = lambda text: text
    dora = types.ModuleType("dora")
    dora.log = log
    sys.modules.setdefault("dora", dora)
    sys.modules.setdefault("dora.log", log)


def decode(path, seconds, rate):
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-t", str(seconds), "-vn", "-ac", "2", "-ar", str(rate), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return torch.from_numpy(np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy())


def encode(wav, rate, path):
    data = wav.clamp(-1, 1).T.contiguous().numpy().astype(np.float32).tobytes()
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(rate), "-ac", "2", "-i", "-", "-c:a", "aac", "-b:a", "160k", path]
    subprocess.run(cmd, input=data, check=True)


def main():
    parser = argparse.ArgumentParser(description="Time background-music removal on one file")
    parser.add_argument("input", help="video or audio file")
    parser.add_argument("--seconds", type=float, default=120, help="length of the test excerpt")
    parser.add_argument("--model", default="htdemucs", help="htdemucs (faster) or htdemucs_ft (better, about 4x slower)")
    parser.add_argument("--threads", type=int, default=os.cpu_count())
    args = parser.parse_args()

    torch.set_num_threads(args.threads)
    stub_dora()
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    print(f"Loading {args.model} (the first run downloads about 80 MB)...")
    started = time.time()
    model = get_model(args.model)
    model.eval()
    print(f"Model ready in {time.time() - started:.0f} s")

    wav = decode(args.input, args.seconds, model.samplerate)
    if wav.shape[1] == 0:
        sys.exit("No audio found in the input")
    length = wav.shape[1] / model.samplerate

    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    print(f"Separating {length:.0f} s of audio on {args.threads} threads...")
    started = time.time()
    with torch.inference_mode():
        sources = apply_model(model, ((wav - mean) / std)[None], split=True, overlap=0.25, progress=True, device="cpu")[0]
    took = time.time() - started
    voice = sources[model.sources.index("vocals")] * std + mean

    base = os.path.splitext(args.input)[0]
    encode(wav, model.samplerate, f"{base}.original-test.m4a")
    encode(voice, model.samplerate, f"{base}.voice-test.m4a")

    ratio = took / length
    print()
    print(f"Separation took {took:.0f} s for {length:.0f} s of audio ({ratio:.2f}x real time)")
    print(f"Estimate for 1 hour of video: about {ratio * 60:.0f} minutes")
    print(f"Listen and compare:\n  {base}.original-test.m4a\n  {base}.voice-test.m4a")


main()
