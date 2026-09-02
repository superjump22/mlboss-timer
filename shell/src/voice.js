// 声音提示: 三档 soundMode = "voice"(语音播报) | "beep"(提示音) | "mute"(静音)
// 语音 = Audio 池预加载 wav (中英各一套, 按语言选用); 提示音 = Web Audio 合成 (无音频文件)
import { BOSS, SKILLS } from "./skills.js";
import { locale } from "./i18n.js";

const pools = { zh: new Map(), en: new Map() };

function keyOf(id, lang) {
  return `${BOSS}_${id}_ready${lang === "en" ? "_en" : ""}`;
}

export function preloadVoices() {
  for (const s of SKILLS) {
    for (const lang of ["zh", "en"]) {
      const a = new Audio(`/voices/${keyOf(s.id, lang)}.wav`);
      a.preload = "auto";
      a.volume = 0.9;
      pools[lang].set(s.id, a);
    }
  }
}

let unlocked = false;
export function unlockAudio() {
  if (!unlocked) {
    unlocked = true;
    for (const a of pools.zh.values()) {
      a.play().then(() => {
        a.pause();
        a.currentTime = 0;
      }).catch(() => {});
      break; // 一个即可解锁
    }
  }
  // AudioContext 同样需手势激活
  const ctx = ensureCtx();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
}

export function sayReady(skillId) {
  const a = pools[locale.value]?.get(skillId);
  if (!a) return;
  a.currentTime = 0;
  a.play().catch(() => {});
}

let audioCtx = null; // 提示音用 AudioContext (惰性创建)

function ensureCtx() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

// 提示音: 与原版 timer 完全一致 (三声上行 1000/1100/1200Hz, 间隔 150ms, 各 80ms)
export function beepReady() {
  const ctx = ensureCtx();
  if (!ctx || ctx.state !== "running") return;
  for (let i = 0; i < 3; i++) {
    const t = ctx.currentTime + i * 0.15;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 1000 + i * 100;
    gain.gain.setValueAtTime(0.08, t);
    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.08);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.08);
  }
}

// 就绪时按模式播放
export function announceReady(skillId, mode) {
  if (mode === "voice") sayReady(skillId);
  else if (mode === "beep") beepReady();
  // mute: 无操作
}

// 原版单音 playSound: start=800Hz/0.1s, reset=600Hz/0.15s, gain 0.05->0.01
function playTone(freq, duration) {
  const ctx = ensureCtx();
  if (!ctx || ctx.state !== "running") return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.05, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + duration);
}

// 开始计时: 原版 start 音 (非静音即播)
export function announceStart(mode) {
  if (mode === "mute") return;
  playTone(800, 0.1);
}

// 重置停止: 原版 reset 音 (非静音即播)
export function announceReset(mode) {
  if (mode === "mute") return;
  playTone(600, 0.15);
}
