#!/usr/bin/env python3
"""
Synthesizes the two bundled ambience loops from pure math (random noise +
filters), so they are 100% self-made and dedicated to the public domain (CC0).

  public/audio/fireplace-loop.mp3   crackling fire
  public/audio/rain-loop.mp3        steady rain

Requires: python3 + numpy, and ffmpeg for MP3 encoding.
Run:      python3 scripts/make-ambience.py
"""
import subprocess, wave
from pathlib import Path
import numpy as np

SR = 44100
SECONDS = 24
FADE = 2.0  # seconds of crossfade used to make the loop seamless
rng = np.random.default_rng(7)
OUT = Path(__file__).resolve().parent.parent / "public" / "audio"

def one_pole_lowpass(x, cutoff):
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x); acc = 0.0
    for i, v in enumerate(x):
        acc = (1 - a) * v + a * acc
        y[i] = acc
    return y

def highpass(x, cutoff):
    return x - one_pole_lowpass(x, cutoff)

def make_loop(sig):
    """Crossfade the tail into the head so the file loops without a click."""
    n = int(FADE * SR)
    body = sig[: len(sig) - n].copy()
    ramp = np.linspace(0, 1, n)
    body[:n] = body[:n] * ramp + sig[len(sig) - n:] * (1 - ramp)
    return body

def normalize(x, peak=0.8):
    return x / (np.max(np.abs(x)) + 1e-9) * peak

def fireplace():
    n = (SECONDS + int(FADE)) * SR
    rumble = one_pole_lowpass(one_pole_lowpass(rng.standard_normal(n), 180), 180) * 6
    crackle = np.zeros(n)
    t = 0
    while t < n - SR // 10:
        t += int(rng.exponential(SR * 0.09))  # ~11 crackles per second
        length = int(rng.uniform(0.004, 0.03) * SR)
        env = np.exp(-np.linspace(0, rng.uniform(4, 9), length))
        amp = rng.uniform(0.05, 1.0) ** 2.2
        if t + length < n:
            crackle[t:t + length] += rng.standard_normal(length) * env * amp
    crackle = highpass(crackle, 900)
    hiss = highpass(rng.standard_normal(n), 3000) * 0.02
    return normalize(make_loop(rumble * 0.5 + crackle + hiss), 0.7)

def rain():
    n = (SECONDS + int(FADE)) * SR
    white = rng.standard_normal(n)
    body = one_pole_lowpass(highpass(white, 400), 5000) * 0.6
    drops = np.zeros(n)
    idx = rng.integers(0, n - 400, size=SECONDS * 60)
    for i in idx:
        L = int(rng.uniform(30, 250))
        drops[i:i + L] += rng.standard_normal(L) * np.exp(-np.linspace(0, 6, L)) * rng.uniform(0.1, 0.6)
    drops = highpass(drops, 1500)
    # slow swell so it does not sound like a static hiss
    swell = 0.85 + 0.15 * np.sin(np.linspace(0, 2 * np.pi * 3, n))
    return normalize(make_loop((body + drops) * swell), 0.6)

def write_mp3(name, sig):
    wav = OUT / f"{name}.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((sig * 32767).astype(np.int16).tobytes())
    mp3 = OUT / f"{name}.mp3"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav),
                    "-codec:a", "libmp3lame", "-b:a", "80k", str(mp3)], check=True)
    wav.unlink()
    print("wrote", mp3, mp3.stat().st_size, "bytes")

OUT.mkdir(parents=True, exist_ok=True)
write_mp3("fireplace-loop", fireplace())
write_mp3("rain-loop", rain())
