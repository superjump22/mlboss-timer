<script setup>
// 主客户端窗口 = 计时器管理中心: 三 boss 卡片(AUF/PB/HT) + 设置 + 帮助
// 建房后悬浮窗创建, 本窗口保持显示; X = 最小化到托盘
import { computed, onMounted, reactive, ref } from "vue";
import { BossSync } from "./sync.js";
import { preloadVoices, unlockAudio } from "./voice.js";
import { locale, setLocale as baseSetLocale, t } from "./i18n.js";
import { BOSSES } from "./bosses.js";

const isTauri = !!window.__TAURI__;
const invoke = (cmd, args) =>
  isTauri ? window.__TAURI__.core.invoke(cmd, args).catch((e) => console.error(cmd, e)) : null;
const emit = (event, payload) =>
  isTauri ? window.__TAURI__.event.emit(event, payload).catch(() => {}) : null;

// ---- Boss 卡片 (单房间模型: 同时只有一个活跃房间, 切卡 = 离开旧房 + 新建房) ----
const bossList = Object.values(BOSSES);
const sync = new BossSync();
const inRoom = ref(false);
const syncStatus = ref("idle");
const activeBoss = ref(localStorage.getItem("activeBoss") || "auf"); // UI/设置分区用; 合法性由 bosses.js 保证
const roomInputs = reactive({});
for (const b of bossList) roomInputs[b.id] = localStorage.getItem(`room_${b.id}`) || "";
const roomErr = ref("");
const errBoss = ref("");
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
const activeCard = (b) => inRoom.value && activeBoss.value === b.id;

function randomRoom() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function joinRoom(bossId) {
  const code = roomInputs[bossId].trim().toUpperCase();
  if (code && !/^[A-Z0-9]{4,6}$/.test(code)) {
    roomErr.value = t("roomErr");
    errBoss.value = bossId;
    return;
  }
  roomErr.value = "";
  errBoss.value = "";
  if (inRoom.value) leaveRoom(); // 切 boss = 离开旧房 (单房间模型)
  awaitRoomState = true; // 等首个 room_state_sync 判定是否空房间 (应用记忆偏移)
  const room = code || randomRoom();
  roomInputs[bossId] = room;
  localStorage.setItem(`room_${bossId}`, room);
  localStorage.setItem("room", room);
  localStorage.setItem("activeBoss", bossId);
  activeBoss.value = bossId;
  reloadAppearance(); // 切 boss 后外观设置读对应分 key
  unlockAudio();
  sync.join(room);
  inRoom.value = true;
  // 创建悬浮窗 (主窗口保持显示); boss 参数决定面板位置存储分 key
  invoke("open_overlay", { boss: bossId });
}
function quickCreate(bossId) {
  roomInputs[bossId] = "";
  joinRoom(bossId);
}
function leaveRoom() {
  sync.leave();
  inRoom.value = false;
  syncStatus.value = "idle";
  invoke("close_overlay");
  emit("room-left");
}
function retryJoin() {
  const room = sync.room || roomInputs[activeBoss.value]?.trim().toUpperCase();
  if (!room) return;
  roomInputs[activeBoss.value] = room;
  awaitRoomState = true;
  unlockAudio();
  sync.join(room);
}

// ---- PB 名字 (纯本地: localStorage 持久化, 服务器不同步 — 见交接文档 3.3 实测结论) ----
const NAME_KEYS = ["ress1", "ress2", "ress3", "ress4", "ress5", "tl1", "tl2", "tl3"];
const pbNames = reactive({});
const namesMsg = ref(null);
let namesMsgTimer = null;
function loadPbNames() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem("pbNames") || "{}");
  } catch {
    /* 损坏则重置 */
  }
  for (const k of NAME_KEYS) pbNames[k] = typeof saved[k] === "string" ? saved[k] : "";
}
loadPbNames();
function savePbNames() {
  const out = {};
  for (const k of NAME_KEYS) out[k] = pbNames[k].trim().slice(0, 10); // 名字 ≤10 字符
  localStorage.setItem("pbNames", JSON.stringify(out));
  loadPbNames(); // 归一化显示
  emit("settings-changed"); // 悬浮窗刷新名字
  namesMsg.value = t("namesSaved");
  clearTimeout(namesMsgTimer);
  namesMsgTimer = setTimeout(() => (namesMsg.value = null), 2000);
}

// ---- 偏移 (全房同步, 计时上限 = CD - offset, 下限 5s; lastOffset 本地记忆) ----
// 语义: 加入"干净"房间 (room_state_sync 无计时器且 offset=0) → 自动应用记忆值,
// 即"第一个动它的人为准"; 房间已有 offset/计时器 → 以房间为准
const offsetInput = ref(parseInt(localStorage.getItem("lastOffset") || "0", 10) || 0);
const offsetMsg = ref(null); // {key, n, ok} 渲染时翻译 → 语言切换实时刷新
let offsetMsgTimer = null;
let awaitRoomState = false; // join 后等首个 room_state_sync 判定空房间
function lastOffset() {
  return parseInt(localStorage.getItem("lastOffset") || "0", 10) || 0;
}
function showOffsetMsg(key, n, ok) {
  offsetMsg.value = { key, n, ok };
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
      showOffsetMsg("offsetAuto", last, true);
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
  if (source === "remote" || source === "joined" && n > 0) showOffsetMsg("offsetSynced", n, true); // 队友改动/加入已有偏移房间 → 统一提示
  else if (source === "local") showOffsetMsg("offsetApplied", n, true);
};
function applyOffset() {
  const v = Math.round(Number(offsetInput.value));
  if (offsetInput.value === "" || !Number.isInteger(v) || v < 0 || v > 30) {
    showOffsetMsg("offsetErr", null, false);
    return;
  }
  offsetInput.value = v;
  if (!sync.room) {
    // 未进房: 仅更新记忆值 (下次建房/进空房时生效)
    localStorage.setItem("lastOffset", String(v));
    showOffsetMsg("offsetSaved", v, true);
    return;
  }
  sync.setOffset(v) || showOffsetMsg("offsetUnchanged", null, true); // 值未变时 setOffset 静默返回 false
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

// ---- 设置 (声音/语言/offset 全局; 透明度/缩放按 boss 分 key — 悬浮窗设置独立) ----
// lsGet: 优先 {key}_{boss}, 回退旧全局 {key} (v1.1.x 迁移)
function lsGet(key, fallback) {
  return localStorage.getItem(`${key}_${activeBoss.value}`) ?? localStorage.getItem(key) ?? fallback;
}
const soundMode = ref(localStorage.getItem("soundMode") || "beep");
const SOUND_OPTIONS = [
  { value: "voice", label: () => t("voice") },
  { value: "beep", label: () => t("beep") },
  { value: "mute", label: () => t("mute") },
];
const panelOpacity = ref(parseFloat(lsGet("panelOpacity", "0.85")));
const uiScale = ref(parseFloat(lsGet("uiScale", "1")));
// 外观设置仅作用于当前 boss (卡片切换后滑块跟随)
const appearanceBossLabel = computed(() => BOSSES[activeBoss.value]?.label || "AUF");

function persistSettings() {
  localStorage.setItem("soundMode", soundMode.value);
  localStorage.setItem(`panelOpacity_${activeBoss.value}`, String(panelOpacity.value));
  localStorage.setItem(`uiScale_${activeBoss.value}`, String(uiScale.value));
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
// 切 boss 后重读外观值 (滑块显示对应 boss 的设置)
function reloadAppearance() {
  panelOpacity.value = parseFloat(lsGet("panelOpacity", "0.85"));
  uiScale.value = parseFloat(lsGet("uiScale", "1"));
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

// ---- 更新 (EdgeOne manifest 主渠道: 检查 → 窗口内下载(进度) → 安装并重启) ----
const version = ref("");
const RELEASES_URL = "https://github.com/superjump22/mlboss-timer/releases/latest"; // 检查/下载失败时手动入口
const updateInfo = ref(null); // { version, url, sha256, notes_zh, notes_en, has_update }
const updateState = ref("idle"); // idle|checking|done|downloading|ready|error
const updateErrKey = ref("checkFailed"); // 失败阶段文案 (checkFailed|downloadFailed)
const updateProg = ref({ received: 0, total: 0 });
let setupPath = "";

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
    updateErrKey.value = "checkFailed";
    updateState.value = "error";
    console.error(e);
  }
}
async function startDownload() {
  if (!updateInfo.value?.url) return;
  updateState.value = "downloading";
  updateProg.value = { received: 0, total: 0 };
  try {
    // 不用 invoke 辅助函数 (它会吞错), 下载失败需要感知
    setupPath = await window.__TAURI__.core.invoke("download_update", {
      url: updateInfo.value.url,
      sha256: updateInfo.value.sha256 || "",
    });
    updateState.value = "ready";
  } catch (e) {
    updateErrKey.value = "downloadFailed";
    updateState.value = "error";
    console.error(e);
  }
}
function installNow() {
  if (!setupPath) return;
  window.__TAURI__.core.invoke("install_update", { path: setupPath }).catch((e) => console.error(e));
}
function openGitHub() {
  invoke("open_url", { url: RELEASES_URL });
}
const updateNotes = computed(
  () => (locale.value === "en" ? updateInfo.value?.notes_en : updateInfo.value?.notes_zh) || ""
);
const progPct = computed(() => {
  const { received, total } = updateProg.value;
  return total > 0 ? Math.min(100, (received / total) * 100) : 0;
});
const progText = computed(() => {
  const { received, total } = updateProg.value;
  const mb = (n) => (n / 1048576).toFixed(1);
  return total > 0 ? `${mb(received)}/${mb(total)} MB` : `${mb(received)} MB`;
});

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
      // 下载进度 (Rust download_update 周期上报)
      await listen("update_progress", (e) => {
        updateProg.value = { received: e.payload?.received || 0, total: e.payload?.total || 0 };
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
      <!-- 版本与更新 (置顶, 永远首屏可见): 有更新 → 立即更新 → 下载进度 → 安装并重启 -->
      <div class="versionrow">
        <span class="muted">v{{ version }}</span>
        <button
          v-if="updateInfo?.has_update && updateState === 'done'"
          class="pill ok updatepill"
          :title="updateNotes"
          @click="startDownload"
        >
          {{ t("newVersion") }} v{{ updateInfo.version }} · {{ t("updateNow") }}
        </button>
        <div v-else-if="updateState === 'downloading'" class="progbox">
          <div class="progbar"><div class="progfill" :style="{ width: progPct + '%' }"></div></div>
          <span class="progtext">{{ progText }}</span>
        </div>
        <button v-else-if="updateState === 'ready'" class="pill ok updatepill" @click="installNow">
          v{{ updateInfo?.version }} · {{ t("installRestart") }}
        </button>
        <button
          v-else-if="updateState === 'error'"
          class="muted plain link"
          :title="RELEASES_URL"
          @click="openGitHub"
        >
          {{ t(updateErrKey) }} · GitHub
        </button>
        <button v-else-if="updateState === 'done'" class="muted plain">
          {{ t("upToDate") }}
        </button>
        <span class="flex1"></span>
        <button
          class="btn ghost sm"
          :disabled="updateState === 'checking' || updateState === 'downloading'"
          @click="doCheckUpdate"
        >
          {{ updateState === "checking" ? t("checking") : t("checkUpdate") }}
        </button>
      </div>

      <!-- 计时器卡片 (单房间: 活跃卡片显示房间控制, 其余卡片可直接加入 = 切换 boss) -->
      <div class="section">
        <div class="secTitle">{{ t("timersSection") }}</div>
        <div
          v-for="b in bossList"
          :key="b.id"
          class="timercard"
          :class="{ active: activeCard(b) }"
        >
          <div class="tcHead">
            <span class="tcName">{{ b.label }}</span>
            <span v-if="activeCard(b)" class="pill" :class="statusCls">{{ statusText }}</span>
            <span v-else class="pill off">{{ t("notEnabled") }}</span>
          </div>
          <template v-if="!activeCard(b)">
            <button class="btn big" @click="quickCreate(b.id)">{{ t("quickCreate") }}</button>
            <div class="joinrow">
              <input
                v-model="roomInputs[b.id]"
                :placeholder="t('roomCodePh')"
                maxlength="6"
                class="inp"
                @keyup.enter="joinRoom(b.id)"
              />
              <button class="btn" @click="joinRoom(b.id)">{{ t("join") }}</button>
            </div>
            <p v-if="roomErr && errBoss === b.id" class="err">{{ roomErr }}</p>
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
            <!-- PB 名字编辑 (纯本地) -->
            <div v-if="b.id === 'pb'" class="namesedit">
              <div class="namesTitle">{{ t("pbNamesTitle") }}</div>
              <div class="namesgrid">
                <label v-for="k in NAME_KEYS" :key="k" class="nameslot">
                  <span class="slotph">{{ k.startsWith("ress") ? "R" + k.slice(4) : "TL" + k.slice(2) }}</span>
                  <input v-model="pbNames[k]" maxlength="10" class="inp namesinp" :placeholder="t('namesPh')" />
                </label>
              </div>
              <div class="namesrow">
                <span v-if="namesMsg" class="muted">{{ namesMsg }}</span>
                <span class="flex1"></span>
                <button class="btn sm" @click="savePbNames">{{ t("namesSave") }}</button>
              </div>
            </div>
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
            <span class="setlabel">
              {{ t("opacity") }}
              <span class="bossTag">{{ appearanceBossLabel }}</span>
            </span>
            <div class="sliderbox">
              <input v-model.number="panelOpacity" type="range" min="0.5" max="1" step="0.01" @input="applyAppearance" />
              <span class="sliderval">{{ Math.round(panelOpacity * 100) }}%</span>
            </div>
          </div>
          <div class="setrow">
            <span class="setlabel">
              {{ t("scale") }}
              <span class="bossTag">{{ appearanceBossLabel }}</span>
            </span>
            <div class="sliderbox">
              <input v-model.number="uiScale" type="range" min="0.5" max="1.5" step="0.05" @input="applyAppearance" />
              <span class="sliderval">{{ Math.round(uiScale * 100) }}%</span>
            </div>
          </div>
          <div class="setrow">
            <span class="setlabel offsetlabel">
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
              <span v-if="offsetMsg" class="offsetmsg" :class="offsetMsg.ok ? 'ok' : 'err'">{{
                offsetMsg.n === null
                  ? t(offsetMsg.key)
                  : t(offsetMsg.key).replace("{n}", offsetMsg.n)
              }}</span>
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
.plain.link {
  cursor: pointer;
  text-decoration: underline dotted;
}
.plain.link:hover {
  color: rgba(255, 255, 255, 0.8);
}
/* 下载进度条 */
.progbox {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.progbar {
  flex: 1;
  max-width: 220px;
  height: 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
}
.progfill {
  height: 100%;
  background: #4ade80;
  border-radius: 4px;
  transition: width 0.15s;
}
.progtext {
  font-family: Consolas, monospace;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.65);
  white-space: nowrap;
}

/* ---- PB 名字编辑 ---- */
.namesedit {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
}
.namesTitle {
  font-size: 12px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.55);
  letter-spacing: 1px;
}
.namesgrid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.nameslot {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.slotph {
  font-size: 11px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.4);
  font-family: Consolas, monospace;
}
.namesinp {
  padding: 4px 8px;
  font-size: 12px;
  min-width: 0;
}
.namesrow {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 外观设置的 boss 归属标签 */
.bossTag {
  font-size: 10px;
  font-weight: 700;
  color: #4ade80;
  background: rgba(74, 222, 128, 0.12);
  border-radius: 4px;
  padding: 1px 5px;
  margin-left: 4px;
  vertical-align: 1px;
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
/* 偏移标签: flex 对齐, 问号图标与文字中线水平 */
.offsetlabel {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
/* 问号帮助图标: hover/聚焦显示说明气泡 */
.helpicon {
  position: relative;
  display: inline-flex;
  align-items: center;
  color: rgba(255, 255, 255, 0.35);
  cursor: help;
}
.helpicon:hover,
.helpicon:focus {
  color: rgba(255, 255, 255, 0.75);
  outline: none;
}
.helptip {
  position: absolute;
  left: 0; /* 锚定图标左缘向右展开: 居中定位在 520px 窄窗口会被左缘截断 */
  bottom: 100%;
  width: max-content;
  max-width: 250px;
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
  transform: translateY(4px);
  transition: opacity 0.12s, transform 0.12s;
  z-index: 5;
}
.helpicon:hover .helptip,
.helpicon:focus .helptip {
  opacity: 1;
  transform: translateY(0);
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
