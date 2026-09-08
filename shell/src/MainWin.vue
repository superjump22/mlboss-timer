<script setup>
// 主客户端窗口 = 计时器管理中心: 计时器卡片(AUF, 未来加 HT 等) + 设置 + 帮助
// 建房后悬浮窗创建, 本窗口保持显示; X = 最小化到托盘
import { computed, onMounted, ref } from "vue";
import { BossSync } from "./sync.js";
import { preloadVoices, unlockAudio } from "./voice.js";
import { locale, setLocale as baseSetLocale, t } from "./i18n.js";

const isTauri = !!window.__TAURI__;
const invoke = (cmd, args) =>
  isTauri ? window.__TAURI__.core.invoke(cmd, args).catch((e) => console.error(cmd, e)) : null;
const emit = (event, payload) =>
  isTauri ? window.__TAURI__.event.emit(event, payload).catch(() => {}) : null;

// ---- 房间 ----
const sync = new BossSync();
const inRoom = ref(false);
const syncStatus = ref("idle");
const roomInput = ref(localStorage.getItem("room") || "");
const roomErr = ref("");
sync.onStatus = (s) => (syncStatus.value = s);
sync.onJoined = () => (inRoom.value = true);

const statusText = computed(
  () =>
    ({
      connecting: t("stConnecting"),
      connected: t("stConnected"),
      reconnecting: t("stReconnecting"),
      failed: t("stFailed"),
    })[syncStatus.value] || syncStatus.value
);
const statusCls = computed(
  () => ({ connected: "ok", reconnecting: "warn", failed: "err" }[syncStatus.value] || "")
);

function randomRoom() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function joinRoom() {
  const code = roomInput.value.trim().toUpperCase();
  if (code && !/^[A-Z0-9]{4,6}$/.test(code)) {
    roomErr.value = t("roomErr");
    return;
  }
  roomErr.value = "";
  awaitRoomState = true; // 等首个 room_state_sync 判定是否空房间 (应用记忆偏移)
  const room = code || randomRoom();
  roomInput.value = room;
  localStorage.setItem("room", room);
  unlockAudio();
  sync.join(room);
  inRoom.value = true;
  // 创建悬浮窗 (主窗口保持显示)
  invoke("open_overlay");
}
function quickCreate() {
  roomInput.value = "";
  joinRoom();
}
function leaveRoom() {
  sync.leave();
  inRoom.value = false;
  syncStatus.value = "idle";
  invoke("close_overlay");
  emit("room-left");
}
function retryJoin() {
  const room = sync.room || roomInput.value.trim().toUpperCase();
  if (!room) return;
  roomInput.value = room;
  awaitRoomState = true;
  unlockAudio();
  sync.join(room);
}

// ---- 偏移 (全房同步, 计时上限 = CD - offset, 下限 5s; lastOffset 本地记忆) ----
// 语义: 加入"干净"房间 (room_state_sync 无计时器且 offset=0) → 自动应用记忆值,
// 即"第一个动它的人为准"; 房间已有 offset/计时器 → 以房间为准
const offsetInput = ref(parseInt(localStorage.getItem("lastOffset") || "0", 10) || 0);
const offsetMsg = ref(null); // {text, ok} 短暂显示
let offsetMsgTimer = null;
let awaitRoomState = false; // join 后等首个 room_state_sync 判定空房间
function lastOffset() {
  return parseInt(localStorage.getItem("lastOffset") || "0", 10) || 0;
}
function showOffsetMsg(text, ok) {
  offsetMsg.value = { text, ok };
  clearTimeout(offsetMsgTimer);
  offsetMsgTimer = setTimeout(() => (offsetMsg.value = null), 2500);
}
sync.onJoined = () => {
  inRoom.value = true;
  offsetInput.value = sync.roomOffset; // 先同步房间实际值 (含 0)
};
sync.onRoomState = (timers) => {
  if (!awaitRoomState) return;
  awaitRoomState = false;
  // 空房间判定: 无任何计时器记录且 offset 未被设置过
  if (Object.keys(timers).length === 0 && sync.roomOffset === 0) {
    const last = lastOffset();
    if (last > 0) {
      sync.setOffset(last); // onOffsetChange 会刷新输入框+记忆
      showOffsetMsg(t("offsetAuto").replace("{n}", last), true);
    }
  }
};
sync.onOffsetChange = (n, source) => {
  if (source === "left") {
    offsetInput.value = lastOffset(); // 离房: 协议层已归 0, UI 显示记忆值
    return;
  }
  offsetInput.value = n;
  localStorage.setItem("lastOffset", String(n)); // 历史记忆 (本地改/房间同步均更新)
  if (source === "remote") showOffsetMsg(t("offsetSynced").replace("{n}", n), true);
  else if (source === "local") showOffsetMsg(t("offsetApplied").replace("{n}", n), true);
};
function applyOffset() {
  const v = Math.round(Number(offsetInput.value));
  if (offsetInput.value === "" || !Number.isInteger(v) || v < 0 || v > 30) {
    showOffsetMsg(t("offsetErr"), false);
    return;
  }
  offsetInput.value = v;
  if (!sync.room) {
    // 未进房: 仅更新记忆值 (下次建房/进空房时生效)
    localStorage.setItem("lastOffset", String(v));
    showOffsetMsg(t("offsetSaved").replace("{n}", v), true);
    return;
  }
  sync.setOffset(v) || showOffsetMsg(t("offsetUnchanged"), true); // 值未变时 setOffset 静默返回 false
}

// ---- 复制房间码 (已进房时) ----
const copied = ref(false);
let copyTimer = null;
async function copyRoom() {
  const room = sync.room;
  if (!room) return;
  try {
    await navigator.clipboard.writeText(room);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = room;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* 放弃 */
    }
    ta.remove();
  }
  copied.value = true;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copied.value = false), 1500);
}
// 回到游戏: 游戏窗口前台+聚焦
function backToGame() {
  invoke("focus_game");
}

// ---- 设置 (localStorage; 悬浮窗监听 settings-changed 重读) ----
const soundMode = ref(localStorage.getItem("soundMode") || "beep");
const SOUND_OPTIONS = [
  { value: "voice", label: () => t("voice") },
  { value: "beep", label: () => t("beep") },
  { value: "mute", label: () => t("mute") },
];
const panelOpacity = ref(parseFloat(localStorage.getItem("panelOpacity") || "0.85"));
const uiScale = ref(parseFloat(localStorage.getItem("uiScale") || "1"));

function persistSettings() {
  localStorage.setItem("soundMode", soundMode.value);
  localStorage.setItem("panelOpacity", panelOpacity.value);
  localStorage.setItem("uiScale", uiScale.value);
  emit("settings-changed");
}
function setSoundMode(m) {
  soundMode.value = m;
  persistSettings();
  unlockAudio();
}
function applyAppearance() {
  persistSettings();
}
// 语言切换: 写 localStorage + 通知悬浮窗
function setLocale(l) {
  baseSetLocale(l);
  emit("settings-changed");
}
function resetDefaults() {
  soundMode.value = "beep";
  panelOpacity.value = 0.85;
  uiScale.value = 1;
  setLocale("zh");
  persistSettings();
  unlockAudio();
}

// ---- 更新检查 (GitHub Releases; UI 热更新走 EdgeOne Pages) ----
const version = ref("");
const updateInfo = ref(null); // { version, url, has_update }
const updateState = ref("idle"); // idle|checking|done|error

if (isTauri) {
  window.__TAURI__.app.getVersion().then((v) => (version.value = v)).catch(() => {});
}
async function doCheckUpdate() {
  if (!isTauri) return;
  updateState.value = "checking";
  try {
    updateInfo.value = await window.__TAURI__.core.invoke("check_update");
    updateState.value = "done";
  } catch (e) {
    updateState.value = "error";
    console.error(e);
  }
}
function openDownload() {
  if (updateInfo.value?.url) invoke("open_url", { url: updateInfo.value.url });
}

onMounted(async () => {
  preloadVoices();
  doCheckUpdate(); // 启动检查 (静默: 失败不打扰)
  // 主窗口高度按内容自适应 (宽度固定 520)
  requestAnimationFrame(() => {
    const el = document.querySelector(".content");
    if (el) {
      const h = Math.ceil(el.getBoundingClientRect().height) + 40;
      invoke("set_window_size", { width: 520, height: Math.max(400, h) });
    }
  });
  if (isTauri) {
    try {
      const { listen } = window.__TAURI__.event;
      // 悬浮窗离房 → 更新本窗口状态
      await listen("room-left", () => {
        inRoom.value = false;
        syncStatus.value = "idle";
        offsetInput.value = lastOffset(); // 显示记忆值
      });
    } catch (err) {
      console.error(err);
    }
  }
});
</script>

<template>
  <div class="mainwin">
    <div class="content">
      <!-- 版本与更新 (置顶, 永远首屏可见) -->
      <div class="versionrow">
        <span class="muted">v{{ version }}</span>
        <button
          v-if="updateInfo?.has_update"
          class="pill ok updatepill"
          :title="updateInfo.url"
          @click="openDownload"
        >
          {{ t("newVersion") }} v{{ updateInfo.version }} · {{ t("download") }}
        </button>
        <button v-else-if="updateState === 'done'" class="muted plain">
          {{ t("upToDate") }}
        </button>
        <button v-else-if="updateState === 'error'" class="muted plain">
          {{ t("checkFailed") }}
        </button>
        <span class="flex1"></span>
        <button class="btn ghost sm" :disabled="updateState === 'checking'" @click="doCheckUpdate">
          {{ updateState === "checking" ? t("checking") : t("checkUpdate") }}
        </button>
      </div>

      <!-- 计时器列表 (未来扩展: HT 等副本卡片) -->
      <div class="section">
        <div class="secTitle">{{ t("timersSection") }}</div>
        <div class="timercard" :class="{ active: inRoom }">
          <div class="tcHead">
            <span class="tcName">AUF</span>
            <span v-if="inRoom" class="pill" :class="statusCls">{{ statusText }}</span>
            <span v-else class="pill off">未启用</span>
          </div>
          <template v-if="!inRoom">
            <button class="btn big" @click="quickCreate">{{ t("quickCreate") }}</button>
            <div class="joinrow">
              <input v-model="roomInput" :placeholder="t('roomCodePh')" maxlength="6" class="inp" @keyup.enter="joinRoom" />
              <button class="btn" @click="joinRoom">{{ t("join") }}</button>
            </div>
            <p v-if="roomErr" class="err">{{ roomErr }}</p>
          </template>
          <template v-else>
            <div class="roomline">
              <button class="roomcode" :title="t('copyRoom')" @click="copyRoom">
                {{ copied ? t("copied") : sync.room }}
              </button>
              <button v-if="syncStatus === 'failed'" class="pill err" @click="retryJoin">{{ t("retry") }}</button>
              <span class="flex1"></span>
              <button class="btn" @click="backToGame">{{ t("backToGame") }}</button>
              <button class="btn danger" @click="leaveRoom">{{ t("leaveRoom") }}</button>
            </div>
            <p class="muted">{{ t("lobbyHint") }}</p>
          </template>
        </div>
      </div>

      <!-- 设置 -->
      <div class="section">
        <div class="secTitle">{{ t("settingsSection") }}</div>
        <div class="settings">
          <div class="setrow">
            <span class="setlabel">{{ t("soundMode") }}</span>
            <div class="seg">
              <button
                v-for="o in SOUND_OPTIONS"
                :key="o.value"
                class="segbtn"
                :class="{ active: soundMode === o.value }"
                @click="setSoundMode(o.value)"
              >
                {{ o.label() }}
              </button>
            </div>
          </div>
          <div class="setrow">
            <span class="setlabel">{{ t("opacity") }}</span>
            <div class="sliderbox">
              <input v-model.number="panelOpacity" type="range" min="0.5" max="1" step="0.01" @input="applyAppearance" />
              <span class="sliderval">{{ Math.round(panelOpacity * 100) }}%</span>
            </div>
          </div>
          <div class="setrow">
            <span class="setlabel">{{ t("scale") }}</span>
            <div class="sliderbox">
              <input v-model.number="uiScale" type="range" min="0.5" max="1.5" step="0.05" @input="applyAppearance" />
              <span class="sliderval">{{ Math.round(uiScale * 100) }}%</span>
            </div>
          </div>
          <div class="setrow">
            <span class="setlabel">
              {{ t("offsetLabel") }}
              <span class="helpicon" tabindex="0">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="9.5" stroke-width="1.8" />
                  <path d="M9.6 9.2a2.6 2.6 0 0 1 5 .9c0 1.7-2.6 2.2-2.6 3.5" />
                  <circle cx="12" cy="17" r="0.4" fill="currentColor" stroke="none" />
                </svg>
                <span class="helptip">{{ t("offsetTip") }}</span>
              </span>
            </span>
            <div class="offsetbox">
              <span v-if="offsetMsg" class="offsetmsg" :class="offsetMsg.ok ? 'ok' : 'err'">{{ offsetMsg.text }}</span>
              <input
                v-model="offsetInput"
                type="number"
                min="0"
                max="30"
                step="1"
                class="inp offsetinp"
                @keyup.enter="applyOffset"
              />
              <span class="offsetunit">s</span>
              <button class="btn sm" @click="applyOffset">{{ t("offsetApply") }}</button>
            </div>
          </div>
          <div class="setrow">
            <span class="setlabel">{{ t("language") }}</span>
            <div class="seg">
              <button class="segbtn" :class="{ active: locale === 'zh' }" @click="setLocale('zh')">中文</button>
              <button class="segbtn" :class="{ active: locale === 'en' }" @click="setLocale('en')">English</button>
            </div>
          </div>
          <div class="dialogrow">
            <span class="flex1"></span>
            <button class="btn ghost sm" @click="resetDefaults">{{ t("resetDefaults") }}</button>
          </div>
        </div>
      </div>

      <!-- 帮助提示 -->
      <p class="settingsHint">{{ t("settingsHint") }}</p>
    </div>
  </div>
</template>

<style>
:root {
  color-scheme: dark;
}
* {
  box-sizing: border-box;
}
html,
body {
  height: 100%;
  margin: 0;
}
body {
  font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
  overflow: hidden;
  user-select: none;
  background: #101218;
  color: #eef0f4;
}
input {
  user-select: text;
}

.mainwin {
  height: 100vh;
  overflow: auto;
  background: radial-gradient(ellipse at 50% 10%, #171b26 0%, #0d0f15 70%);
}
.content {
  max-width: 520px;
  margin: 0 auto;
  padding: 16px 18px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.secTitle {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 2px;
  color: rgba(255, 255, 255, 0.4);
  text-transform: uppercase;
  padding-left: 2px;
}

/* ---- 计时器卡片 ---- */
.timercard {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  border-radius: 14px;
  background: rgba(18, 21, 30, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.timercard.active {
  border-color: rgba(74, 222, 128, 0.35);
}
.tcHead {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tcName {
  font-weight: 800;
  font-size: 18px;
  letter-spacing: 2px;
}
.roomline {
  display: flex;
  align-items: center;
  gap: 10px;
}
.roomcode {
  border: none;
  background: rgba(74, 222, 128, 0.1);
  font-family: Consolas, monospace;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 3px;
  color: #4ade80;
  cursor: pointer;
  padding: 2px 10px;
  border-radius: 8px;
}
.roomcode:hover {
  background: rgba(74, 222, 128, 0.2);
}
.joinrow {
  display: flex;
  gap: 8px;
}
.joinrow .inp {
  flex: 1;
  text-transform: uppercase;
  text-align: center;
  letter-spacing: 2px;
}

/* ---- 版本与更新 ---- */
.versionrow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 4px;
}
.updatepill {
  cursor: pointer;
  border: none;
  font-weight: 600;
}
.updatepill:hover {
  background: rgba(74, 222, 128, 0.28);
}
.plain {
  background: none;
  border: none;
  cursor: default;
  font-size: 12px;
}

/* ---- 设置 ---- */
.settings {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-radius: 14px;
  background: rgba(18, 21, 30, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.1);
  padding: 16px 18px 12px;
}
/* 底部提示: 设置卡片下方, 弱化 */
.settingsHint {
  margin: 0;
  padding: 0 6px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
  text-align: center;
}

/* ---- 通用控件 ---- */
.inp {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  color: #eef0f4;
  padding: 6px 10px;
  outline: none;
}
.inp:focus {
  border-color: rgba(74, 222, 128, 0.6);
}
.btn {
  background: #2d6a4f;
  border: none;
  border-radius: 8px;
  color: #fff;
  padding: 7px 14px;
  cursor: pointer;
  font-size: 13px;
}
.btn:hover {
  filter: brightness(1.15);
}
.btn.ghost {
  background: rgba(255, 255, 255, 0.09);
}
.btn.sm {
  padding: 5px 12px;
  font-size: 12px;
  border-radius: 7px;
}
.btn.big {
  font-size: 15px;
  padding: 10px 28px;
}
.btn.danger {
  background: #a63d40;
}
.pill {
  border-radius: 99px;
  padding: 4px 12px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.08);
}
.pill.ok {
  background: rgba(74, 222, 128, 0.15);
  color: #4ade80;
}
.pill.warn {
  background: rgba(255, 209, 102, 0.15);
  color: #ffd166;
}
.pill.err {
  background: rgba(255, 107, 107, 0.15);
  color: #ff7b7b;
  cursor: pointer;
  border: none;
  font-weight: 600;
}
.pill.off {
  color: rgba(255, 255, 255, 0.4);
}
.muted {
  color: rgba(255, 255, 255, 0.5);
  font-size: 12px;
  margin: 0;
}
.err {
  color: #ff7b7b;
  font-size: 12px;
  margin: 0;
}
.flex1 {
  flex: 1;
}
.setrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  min-height: 36px;
}
.setlabel {
  flex-shrink: 0;
}
/* 问号帮助图标: hover/聚焦显示说明气泡 */
.helpicon {
  position: relative;
  display: inline-flex;
  align-items: center;
  margin-left: 4px;
  color: rgba(255, 255, 255, 0.35);
  cursor: help;
  vertical-align: middle;
}
.helpicon:hover,
.helpicon:focus {
  color: rgba(255, 255, 255, 0.75);
  outline: none;
}
.helptip {
  position: absolute;
  left: 50%;
  transform: translateX(-50%) translateY(4px);
  bottom: 100%;
  width: max-content;
  max-width: 240px;
  background: rgba(13, 15, 21, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.85);
  white-space: normal;
  text-align: left;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s, transform 0.12s;
  z-index: 5;
}
.helpicon:hover .helptip,
.helpicon:focus .helptip {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
.keybtn {
  min-width: 140px;
  background: rgba(255, 255, 255, 0.09);
  font-family: Consolas, monospace;
}
.seg {
  display: flex;
  gap: 4px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  padding: 3px;
}
.segbtn {
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.55);
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.segbtn:hover {
  color: #fff;
}
.segbtn.active {
  background: #2d6a4f;
  color: #fff;
}
.sliderbox {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  max-width: 260px;
}
.sliderbox input[type="range"] {
  flex: 1;
  accent-color: #4ade80;
}
.sliderval {
  font-family: Consolas, monospace;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  min-width: 38px;
  text-align: right;
}
/* ---- 偏移行 ---- */
.offsetbox {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  max-width: 380px;
  justify-content: flex-end;
}
.offsetinp {
  width: 64px;
  text-align: center;
  font-family: Consolas, monospace;
}
/* spin 按钮常驻显示 (Chromium 默认 hover 才出现) */
.offsetinp::-webkit-inner-spin-button {
  opacity: 1;
}
.offsetunit {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}
/* 提示文字: 输入框左侧; 允许两行内换行 (行高 ≤36px 不撑高 setrow, 无跳动) */
.offsetmsg {
  flex: 1;
  min-width: 0;
  text-align: right;
  font-size: 12px;
  line-height: 1.25;
  overflow-wrap: break-word;
}
.offsetmsg.ok {
  color: #4ade80;
}
.offsetmsg.err {
  color: #ff7b7b;
}
.dialogrow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px; /* 与上方设置行拉开间距 */
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.07); /* 视觉分组: 操作收尾区 */
}
</style>
