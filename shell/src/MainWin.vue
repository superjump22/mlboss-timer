<script setup>
// 主客户端窗口 = 两级视图 (仿 bossassis.com): Boss 选择 → 加房 + 该 Boss 专属设置
// 选定 boss 后: 建房/加入 (悬浮窗创建), 设置区含 per-boss 项 (PB 多一项队友名字)
// X = 最小化到托盘
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { BossSync } from "./sync.js";
import { preloadVoices, unlockAudio } from "./voice.js";
import { locale, setLocale as baseSetLocale, t, timeFmt as timeFmtRef, localeOf } from "./i18n.js";
import { BOSSES, timeFmtOf } from "./bosses.js";

const isTauri = !!window.__TAURI__;
const invoke = (cmd, args) =>
  isTauri ? window.__TAURI__.core.invoke(cmd, args).catch((e) => console.error(cmd, e)) : null;
const emit = (event, payload) =>
  isTauri ? window.__TAURI__.event.emit(event, payload).catch(() => {}) : null;

// ---- 视图与 Boss 选择 ----
const bossList = Object.values(BOSSES);
const view = ref("select"); // select = 选 Boss | boss = 加房 + 设置
const activeBoss = ref(localStorage.getItem("activeBoss") || "auf");
const bossDef = computed(() => BOSSES[activeBoss.value] || BOSSES.auf);
const skillsCount = (b) => t("skillCount").replace("{n}", b.groups.reduce((n, g) => n + g.skills.length, 0));

function selectBoss(id) {
  activeBoss.value = id;
  localStorage.setItem("activeBoss", id);
  view.value = "boss";
  reloadBossSettings(); // 一切设置 per-boss: 切换即重读 (无共享状态)
}
function backToSelect() {
  if (inRoom.value) leaveRoom();
  view.value = "select";
}

// ---- 房间 (单房间模型: 切 boss = 离开旧房 + 新建房) ----
const sync = new BossSync();
const inRoom = ref(false);
const syncStatus = ref("idle");
const roomInput = ref("");
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
  if (inRoom.value) leaveRoom(); // 切 boss = 离开旧房 (单房间模型)
  awaitRoomState = true; // 等首个 room_state_sync 判定是否空房间 (应用记忆偏移)
  const room = code || randomRoom();
  roomInput.value = room;
  localStorage.setItem("room", room);
  localStorage.setItem("activeBoss", activeBoss.value);
  unlockAudio();
  sync.join(room);
  inRoom.value = true;
  // 创建悬浮窗 (主窗口保持显示); boss 参数决定面板位置存储分 key
  invoke("open_overlay", { boss: activeBoss.value });
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
  // per-boss 记忆 (旧全局 lastOffset 一次性迁移)
  const v = localStorage.getItem(`lastOffset_${activeBoss.value}`) ?? localStorage.getItem("lastOffset");
  return parseInt(v || "0", 10) || 0;
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
  localStorage.setItem(`lastOffset_${activeBoss.value}`, String(n)); // per-boss 记忆 (本地改/房间同步均更新)
  if (source === "remote" || (source === "joined" && n > 0)) showOffsetMsg("offsetSynced", n, true); // 队友改动/加入已有偏移房间 → 统一提示
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
    localStorage.setItem(`lastOffset_${activeBoss.value}`, String(v));
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

// ---- 设置 (全部 per-boss 隔离, 无共享; 旧全局 key 仅作一次性迁移回退) ----
function lsGet(key, fallback) {
  return localStorage.getItem(`${key}_${activeBoss.value}`) ?? localStorage.getItem(key) ?? fallback;
}
const soundMode = ref(lsGet("soundMode", "beep"));
const SOUND_OPTIONS = [
  { value: "voice", label: () => t("voice") },
  { value: "beep", label: () => t("beep") },
  { value: "mute", label: () => t("mute") },
];
const panelOpacity = ref(parseFloat(lsGet("panelOpacity", "0.85")));
const uiScale = ref(parseFloat(lsGet("uiScale", "1")));

function persistSettings() {
  localStorage.setItem(`soundMode_${activeBoss.value}`, soundMode.value);
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
// 切 boss 后重读全部设置 (滑块/开关显示对应 boss 的值)
function reloadBossSettings() {
  soundMode.value = lsGet("soundMode", "beep");
  panelOpacity.value = parseFloat(lsGet("panelOpacity", "0.85"));
  uiScale.value = parseFloat(lsGet("uiScale", "1"));
  timeFmtVal.value = timeFmtOf(activeBoss.value);
  timeFmtRef.value = timeFmtVal.value;
  if (activeBoss.value === "pb")
    showSupport.value = localStorage.getItem("showSupport_pb") !== "0";
  locale.value = localeOf(activeBoss.value); // 语言 per-boss
  if (!inRoom.value) offsetInput.value = lastOffset();
}

// 时间显示格式 (per-boss, 默认按原版网页: AUF 秒数 / PB、HT 分秒): "ms" | "sec"
const timeFmtVal = ref(timeFmtOf(activeBoss.value));
function setTimeFmt(v) {
  timeFmtVal.value = v;
  localStorage.setItem(`timeFmt_${activeBoss.value}`, v);
  timeFmtRef.value = v; // 本窗口即时生效
  emit("settings-changed");
}

// PB 支援技能显示开关 (R/TL 位; 默认显示)
const showSupport = ref(localStorage.getItem("showSupport_pb") !== "0");
function setShowSupport(v) {
  showSupport.value = v;
  localStorage.setItem("showSupport_pb", v ? "1" : "0");
  emit("settings-changed");
}

// 语言切换 (per-boss): 写 locale_{boss} + 通知悬浮窗
function setLocale(l) {
  baseSetLocale(l);
  localStorage.setItem(`locale_${activeBoss.value}`, l);
  emit("settings-changed");
}
function resetDefaults() {
  soundMode.value = "beep";
  panelOpacity.value = 0.85;
  uiScale.value = 1;
  timeFmtVal.value = BOSSES[activeBoss.value]?.timeFmt || "ms"; // 恢复原版默认格式
  localStorage.removeItem(`timeFmt_${activeBoss.value}`);
  if (activeBoss.value === "pb") setShowSupport(true);
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

// ---- 窗口高度自适应 (两级视图高度不同, 切换时重算; 宽度固定 520) ----
// 封顶 = 屏幕可用高度 - 边距: 内容超出时 .mainwin 内部滚动条接管
function adjustHeight() {
  requestAnimationFrame(() => {
    const el = document.querySelector(".content");
    if (el) {
      const h = Math.ceil(el.getBoundingClientRect().height) + 40;
      const cap = (window.screen?.availHeight || 9999) - 80;
      invoke("set_window_size", { width: 520, height: Math.min(Math.max(400, h), Math.max(400, cap)) });
    }
  });
}
watch([view, inRoom], () => adjustHeight(), { flush: "post" });

onMounted(async () => {
  preloadVoices();
  doCheckUpdate(); // 启动检查 (静默: 失败不打扰)
  adjustHeight();
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
    <div
      class="content"
      :style="view === 'boss' ? { '--boss-color': bossDef.color, '--boss-btn': bossDef.btn } : undefined"
    >
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

      <!-- ===== 视图一: 选择 Boss ===== -->
      <div v-if="view === 'select'" class="section">
        <div class="secTitle">{{ t("selectBossTitle") }}</div>
        <button
          v-for="b in bossList"
          :key="b.id"
          class="bosscard"
          :style="{ '--boss-color': b.color }"
          @click="selectBoss(b.id)"
        >
          <div class="bcRow">
            <span class="bcName">{{ b.label }}</span>
            <span class="bcFull">{{ b.full }}</span>
            <span class="flex1"></span>
            <span class="bcCount">{{ skillsCount(b) }}</span>
          </div>
          <div class="bcGroups">
            <span v-for="g in b.groups" :key="g.id" class="bcChip">{{
              locale === "en" && g.labelEn ? g.labelEn : g.label
            }}</span>
          </div>
        </button>
      </div>

      <!-- ===== 视图二: 加房 + 该 Boss 设置 (主题色随 boss) ===== -->
      <template v-else>
        <div class="section">
          <div class="bosHead">
            <button class="btn ghost sm" @click="backToSelect">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M15 5l-7 7 7 7" />
              </svg>
              {{ t("back") }}
            </button>
            <span class="tcName" :style="{ color: bossDef.color }">{{ bossDef.label }}</span>
            <span class="muted bosFull">{{ bossDef.full }}</span>
            <span v-if="inRoom" class="pill" :class="statusCls">{{ statusText }}</span>
            <span class="flex1"></span>
          </div>

          <div class="timercard" :class="{ active: inRoom }">
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

          <!-- PB 专属: 队友名字 (纯本地) — R 5 列一行 / TL 3 列一行 -->
          <div v-if="activeBoss === 'pb'" class="namesedit">
            <div class="namesblock">
              <div class="nbHead">
                <span class="nbTag">R</span><span class="nbLabel">{{ t("pbGroupRes") }}</span>
              </div>
              <div class="namesgrid g5">
                <label v-for="k in NAME_KEYS.slice(0, 5)" :key="k" class="nameslot">
                  <span class="slotph">{{ "R" + k.slice(4) }}</span>
                  <input v-model="pbNames[k]" maxlength="10" class="inp namesinp" :placeholder="t('namesPh')" />
                </label>
              </div>
            </div>
            <div class="namesblock">
              <div class="nbHead">
                <span class="nbTag tl">TL</span><span class="nbLabel">{{ t("pbGroupTl") }}</span>
              </div>
              <div class="namesgrid g3">
                <label v-for="k in NAME_KEYS.slice(5)" :key="k" class="nameslot">
                  <span class="slotph">{{ "TL" + k.slice(2) }}</span>
                  <input v-model="pbNames[k]" maxlength="10" class="inp namesinp" :placeholder="t('namesPh')" />
                </label>
              </div>
            </div>
            <div class="namesrow">
              <span v-if="namesMsg" class="muted">{{ namesMsg }}</span>
              <span class="flex1"></span>
              <button class="btn sm" @click="savePbNames">{{ t("namesSave") }}</button>
            </div>
          </div>
        </div>

        <!-- 设置 (全部 per-boss; 主题色随 boss) -->
        <div class="section">
          <div class="secTitle">{{ t("settingsSection") }}</div>
          <div class="settings">
            <div v-if="activeBoss === 'pb'" class="setrow">
              <span class="setlabel">{{ t("showSupport") }}</span>
              <div class="seg">
                <button class="segbtn" :class="{ active: showSupport }" @click="setShowSupport(true)">{{ t("on") }}</button>
                <button class="segbtn" :class="{ active: !showSupport }" @click="setShowSupport(false)">{{ t("off") }}</button>
              </div>
            </div>
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
                <span class="bossTag">{{ bossDef.label }}</span>
              </span>
              <div class="sliderbox">
                <input v-model.number="panelOpacity" type="range" min="0.5" max="1" step="0.01" @input="applyAppearance" />
                <span class="sliderval">{{ Math.round(panelOpacity * 100) }}%</span>
              </div>
            </div>
            <div class="setrow">
              <span class="setlabel">
                {{ t("scale") }}
                <span class="bossTag">{{ bossDef.label }}</span>
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
              <span class="setlabel">{{ t("timeFmt") }}</span>
              <div class="seg">
                <button class="segbtn" :class="{ active: timeFmtVal === 'ms' }" @click="setTimeFmt('ms')">{{ t("timeFmtMs") }}</button>
                <button class="segbtn" :class="{ active: timeFmtVal === 'sec' }" @click="setTimeFmt('sec')">{{ t("timeFmtSec") }}</button>
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
      </template>
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

/* ---- Boss 选择卡片 (仿 bossassis.com 首页) ---- */
.bosscard {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 20px 22px;
  border-radius: 16px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--boss-color, #4ade80) 10%, rgba(18, 21, 30, 0.92)), rgba(18, 21, 30, 0.92) 65%);
  border: 1px solid rgba(255, 255, 255, 0.1);
  cursor: pointer;
  color: #eef0f4;
  text-align: left;
  transition: background 0.15s, transform 0.15s, border-color 0.15s;
}
.bosscard:hover {
  border-color: color-mix(in srgb, var(--boss-color, #4ade80) 45%, transparent);
  transform: translateY(-2px);
}
.bcRow {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
}
.bcName {
  font-size: 26px;
  font-weight: 800;
  letter-spacing: 2px;
  color: var(--boss-color, #eef0f4);
}
.bcFull {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.45);
  letter-spacing: 1px;
}
.bcCount {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
}
.bcGroups {
  display: flex;
  gap: 6px;
}
.bcChip {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.07);
  color: rgba(255, 255, 255, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

/* ---- Boss 视图头部 ---- */
.bosHead {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 30px;
}
.bosFull {
  letter-spacing: 1px;
}

/* ---- 计时器卡片 (Boss 视图内用主题色) ---- */
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
  border-color: color-mix(in srgb, var(--boss-color, #4ade80) 40%, transparent);
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
  background: color-mix(in srgb, var(--boss-color, #4ade80) 12%, transparent);
  font-family: Consolas, monospace;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 3px;
  color: var(--boss-color, #4ade80);
  cursor: pointer;
  padding: 2px 10px;
  border-radius: 8px;
}
.roomcode:hover {
  background: color-mix(in srgb, var(--boss-color, #4ade80) 22%, transparent);
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
  background: var(--boss-btn, #2d6a4f); /* Boss 视图内随主题色, 其余场景默认绿 */
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
  background: var(--boss-color, #2d6a4f);
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
  accent-color: var(--boss-color, #4ade80);
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

/* ---- PB 名字编辑 (R 5 列 / TL 3 列 分组) ---- */
.namesedit {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 18px;
  border-radius: 14px;
  background: rgba(18, 21, 30, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.namesblock {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.nbHead {
  display: flex;
  align-items: center;
  gap: 6px;
}
.nbTag {
  font-size: 11px;
  font-weight: 800;
  font-family: Consolas, monospace;
  color: #7ce38b;
  background: rgba(124, 227, 139, 0.12);
  border-radius: 4px;
  padding: 1px 6px;
}
.nbTag.tl {
  color: #64dfdf;
  background: rgba(100, 223, 223, 0.12);
}
.nbLabel {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}
.namesgrid {
  display: grid;
  gap: 8px;
}
.namesgrid.g5 {
  grid-template-columns: repeat(5, 1fr);
}
.namesgrid.g3 {
  grid-template-columns: repeat(5, 1fr); /* 与 R 行同宽节奏, TL3 占前 3 列 */
}
.nameslot {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.slotph {
  font-size: 11px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.4);
  font-family: Consolas, monospace;
}
.namesinp {
  padding: 5px 8px;
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
</style>
