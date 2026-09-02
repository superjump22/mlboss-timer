# -*- coding: utf-8 -*-
"""用 edge-tts 生成"就绪"语音到 shell/public/voices/ (中英各一套)

用法:
    pip install edge-tts miniaudio
    python scripts/gen_voices.py [--rate +50%]

文件名约定必须与 shell/src/voice.js 的 keyOf() 一致:
    中文: {boss}_{skillId}_ready.wav
    英文: {boss}_{skillId}_ready_en.wav
修改措辞时同步更新下方 PHRASES / skills.js。
"""
import argparse
import asyncio
import os
import tempfile
import wave

import edge_tts
import miniaudio

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(BASE, "shell", "public", "voices")

# (文件名后缀, TTS 音色, 短语表)
LANGS = [
    (
        "",
        "zh-CN-XiaoxiaoNeural",
        {
            "auf_mdr_ready": "主体反伤好了",
            "auf_mdp_ready": "主体DP好了",
            "auf_sed_ready": "诱惑好了",
            "auf_stun_ready": "眩晕好了",
            "auf_cdr_ready": "分身反伤好了",
            "auf_cdp_ready": "分身DP好了",
        },
    ),
    (
        "_en",
        "en-US-AriaNeural",
        {
            "auf_mdr_ready": "Main D R ready",
            "auf_mdp_ready": "Main D P ready",
            "auf_sed_ready": "Seduce ready",
            "auf_stun_ready": "Stun ready",
            "auf_cdr_ready": "Clone D R ready",
            "auf_cdp_ready": "Clone D P ready",
        },
    ),
]


def mp3_to_wav(mp3_path, wav_path):
    """注意: miniaudio 返回 int16 采样(typecode 'h'), 直接写, 不要按 float 钳位(会爆音)"""
    s = miniaudio.decode_file(mp3_path)
    with wave.open(wav_path, "wb") as w:
        w.setnchannels(s.nchannels)
        w.setsampwidth(2)
        w.setframerate(s.sample_rate)
        w.writeframes(s.samples.tobytes())


async def gen(phrase, mp3_path, voice, rate):
    """edge-tts 偶发 NoAudioReceived, 带重试"""
    last = None
    for attempt in range(5):
        try:
            c = edge_tts.Communicate(phrase, voice, rate=rate)
            await c.save(mp3_path)
            if os.path.getsize(mp3_path) > 0:
                return
            last = RuntimeError("empty file")
        except Exception as e:
            last = e
        await asyncio.sleep(1.5 * (attempt + 1))
    raise last


async def run(rate):
    os.makedirs(OUT_DIR, exist_ok=True)
    total = 0
    with tempfile.TemporaryDirectory() as tmp:
        for suffix, voice, phrases in LANGS:
            for key, text in phrases.items():
                name = f"{key}{suffix}"
                wav = os.path.join(OUT_DIR, f"{name}.wav")
                mp3 = os.path.join(tmp, f"{name}.mp3")
                await gen(text, mp3, voice, rate)
                mp3_to_wav(mp3, wav)
                print(f"  {name}.wav  <-  {text!r}")
                total += 1
    print(f"完成 {total} 条 -> {OUT_DIR}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rate", default="+50%", help="语速, 如 +50%%")
    args = ap.parse_args()
    asyncio.run(run(args.rate))
