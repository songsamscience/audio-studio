#!/usr/bin/env python3
"""Generate synthetic (no personal media) fixtures; native FFmpeg is test-only."""
import argparse
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import wave


def wav(path, duration, channels, signal, rate=48000):
    with wave.open(str(path), "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(2)
        output.setframerate(rate)
        frames = bytearray()
        for n in range(round(duration * rate)):
            for channel in range(channels):
                value = max(-1, min(1, signal(n / rate, channel)))
                frames.extend(struct.pack("<h", round(value * 32767)))
        output.writeframes(frames)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ffmpeg", default=shutil.which("ffmpeg"), help="Optional native FFmpeg binary")
    parser.add_argument("--out", default=str(Path(__file__).parent / "fixtures"))
    args = parser.parse_args()
    dest = Path(args.out).resolve()
    dest.mkdir(parents=True, exist_ok=True)
    tone = lambda t, c: .4 * math.sin(2 * math.pi * (440 if c == 0 else 660) * t)
    wav(dest / "수업 소리 & 테스트.wav", 4, 2, tone)
    wav(dest / "tone-mono-22050.wav", 4, 1, tone, rate=22050)
    wav(dest / "silence.wav", 2, 2, lambda t, c: 0)
    wav(dest / "quiet.wav", 2, 1, lambda t, c: .0001 * math.sin(2 * math.pi * 440 * t))
    wav(dest / "clipped.wav", 2, 2, lambda t, c: 2 * math.sin(2 * math.pi * 440 * t))
    wav(dest / "silence-gaps.wav", 6, 1,
        lambda t, c: tone(t, c) if 1 <= t < 2 or 3.5 <= t < 5 else 0)
    (dest / "empty.wav").write_bytes(b"")
    (dest / "corrupt.mp3").write_bytes(b"not an audio stream\x00\x01\xff")
    generated = {"sampleRate": 48000, "stereoToneDuration": 4,
                 "leftFrequencyHz": 440, "rightFrequencyHz": 660,
                 "toneAmplitude": .4, "nativeFFmpeg": bool(args.ffmpeg)}
    if args.ffmpeg:
        ffmpeg = str(Path(args.ffmpeg).resolve())
        def run(*argv):
            subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *argv], check=True)
        main_audio = str(dest / "수업 소리 & 테스트.wav")
        run("-i", main_audio, "-c:a", "libmp3lame", "-b:a", "192k", str(dest / "tone.mp3"))
        run("-f", "lavfi", "-i", "color=c=orange:s=160x90:r=10:d=4", "-i", main_audio,
            "-map", "0:v", "-map", "1:a", "-c:v", "mpeg4", "-c:a", "aac", "-shortest",
            str(dest / "video-with-audio.mp4"))
        run("-f", "lavfi", "-i", "color=c=orange:s=160x90:r=10:d=4", "-an", "-c:v", "mpeg4",
            str(dest / "video-no-audio.mp4"))
        run("-f", "lavfi", "-i", "color=c=orange:s=160x90:r=10:d=4", "-i", main_audio,
            "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=4",
            "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "mpeg4", "-c:a", "aac",
            "-metadata:s:a:0", "language=kor", "-metadata:s:a:0", "title=수업 원음",
            "-metadata:s:a:1", "language=eng", "-metadata:s:a:1", "title=비교 음원",
            "-shortest", str(dest / "video-multi-track.mp4"))
    (dest / "manifest.json").write_text(json.dumps(generated, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"directory": str(dest), "files": len(list(dest.iterdir())), **generated}, ensure_ascii=False))


if __name__ == "__main__":
    main()
