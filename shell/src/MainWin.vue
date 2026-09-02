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
  unlockAudio();
  sync.join(room);
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
  if (isTauri) {
    try {
      const { listen } = window.__TAURI__.event;
      // 悬浮窗离房 → 更新本窗口状态
      await listen("room-left", () => {
        inRoom.value = false;
        syncStatus.value = "idle";
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
            <span class="setlabel">{{ t("language") }}</span>
            <div class="seg">
              <button class="segbtn" :class="{ active: locale === 'zh' }" @click="setLocale('zh')">中文</button>
              <button class="segbtn" :class="{ active: locale === 'en' }" @click="setLocale('en')">English</button>
            </div>
          </div>
          <div class="dialogrow">
            <button class="btn ghost sm" @click="resetDefaults">{{ t("resetDefaults") }}</button>
          </div>
        </div>
      </div>

      <!-- 版本与更新 -->
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
        <span class="flex1"></span>
        <button class="btn ghost sm" :disabled="updateState === 'checking'" @click="doCheckUpdate">
          {{ updateState === "checking" ? t("checking") : t("checkUpdate") }}
        </button>
      </div>
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
  gap: 4px;
  border-radius: 14px;
  background: rgba(18, 21, 30, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.1);
  padding: 16px 18px;
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
.dialogrow {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
