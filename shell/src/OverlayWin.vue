<script setup>
// 悬浮窗: 计时面板 (进房后由主窗口创建)
// 锁定 = 背景点击穿透 + 不可拖 (格子/按钮仍可点); 解锁 = 全部可交互 + 背景拖拽
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import TimerCell from "./components/TimerCell.vue";
import { SKILLS } from "./skills.js";
import { BossSync } from "./sync.js";
import { announceReady, announceReset, announceStart, preloadVoices, unlockAudio } from "./voice.js";
import { locale, reloadLocale, t } from "./i18n.js";

const isTauri = !!window.__TAURI__;
const invoke = (cmd, args) =>
  isTauri ? window.__TAURI__.core.invoke(cmd, args).catch((e) => console.error(cmd, e)) : null;
const emit = (event, payload) =>
  isTauri ? window.__TAURI__.event.emit(event, payload).catch(() => {}) : null;

// ---- 同步 (Rust WS 桥广播; 房间号从 localStorage 恢复) ----
const sync = new BossSync();
const syncStatus = ref("idle");
const starts = reactive({});
let tickTimer = null;
const nowRef = ref(0);
sync.onStatus = (s) => (syncStatus.value = s);

function syncNow() {
  return (nowRef.value || Date.now()) + sync.offset;
}
function stateOf(skill) {
  const s = starts[skill.id];
  if (!s) return { phase: "idle" };
  const remain = s.cd - (syncNow() - s.startTs) / 1000;
  if (remain <= 0) return { phase: "ready", remain: 0 };
  return { phase: "run", remain };
}
function effCd(s) {
  return Math.max(5, s.cd - sync.roomOffset);
}

const tickSent = {};
const completedSent = new Set();
const announced = new Set();

// ---- 外观/声音 (localStorage; 主窗口设置时经 settings-changed 通知) ----
const soundMode = ref(localStorage.getItem("soundMode") || "beep");
const panelOpacity = ref(parseFloat(localStorage.getItem("panelOpacity") || "0.85"));
const uiScale = ref(parseFloat(localStorage.getItem("uiScale") || "1"));
// 游戏缩放系数 (Rust 下发 = 游戏客户区宽/1600); 面板总 zoom = uiScale × gameFactor
const gameFactor = ref(1);
const panelZoom = computed(() => uiScale.value * gameFactor.value);
function reloadAppearance() {
  reloadLocale(); // 语言跟随主窗口设置
  soundMode.value = localStorage.getItem("soundMode") || "beep";
  panelOpacity.value = parseFloat(localStorage.getItem("panelOpacity") || "0.85");
  uiScale.value = parseFloat(localStorage.getItem("uiScale") || "1");
  // 尺寸上报由 watch(uiScale) 统一触发, 不手动调用 (避免 DOM 未 flush 测量旧值)
}

// ---- 计时操作 ----
function start(idx) {
  const s = SKILLS[idx];
  const st = starts[s.id];
  // 计时进行中单击无效 (防误触, 原版逻辑)
  if (st && st.cd - (syncNow() - st.startTs) / 1000 > 0) {
    focusGame();
    return;
  }
  unlockAudio();
  const cd = effCd(s);
  starts[s.id] = { startTs: syncNow(), cd };
  announced.delete(s.id);
  completedSent.delete(s.id);
  tickSent[s.id] = Math.ceil(cd / 5) * 5;
  sync.startAction(s.pid, cd);
  announceStart(soundMode.value);
  focusGame();
}
function reset(idx) {
  const s = SKILLS[idx];
  delete starts[s.id];
  sync.resetAction(s.pid, effCd(s));
  announceReset(soundMode.value);
  focusGame();
}
function focusGame() {
  invoke("focus_game");
}

// ---- 服务器事件 ----
sync.onTimer = (pid, action, data) => applyRemote(pid, action, data);
sync.onRoomState = (timers) => {
  for (const k of Object.keys(starts)) delete starts[k];
  for (const [pid, d] of Object.entries(timers)) applyRemote(pid, "sync", d);
};
function applyRemote(pid, action, data = {}) {
  const s = SKILLS.find((x) => x.pid === pid);
  if (!s) return;
  if (action === "reset" || action === "pause") {
    delete starts[s.id];
    return;
  }
  if (!data.running && action !== "complete") {
    delete starts[s.id];
    return;
  }
  const serverNow = sync.now();
  const lastUp = typeof data.last_update === "number" ? data.last_update : serverNow / 1000;
  const remain = (data.remaining ?? 0) - (serverNow / 1000 - lastUp);
  const cd = data.duration || s.cd;
  starts[s.id] = { startTs: serverNow - (cd - remain) * 1000, cd };
  tickSent[s.id] = Math.ceil(Math.max(remain, 0) / 5) * 5;
  if (remain > 0) {
    announced.delete(s.id);
    completedSent.delete(s.id);
  } else {
    completedSent.add(s.id);
    if (remain <= -1.5) announced.add(s.id);
  }
}

// ---- 倒计时驱动 ----
function pollReady() {
  for (const s of SKILLS) {
    const st = starts[s.id];
    if (!st) continue;
    const remain = st.cd - (syncNow() - st.startTs) / 1000;
    if (remain > 0) {
      const b = Math.ceil(remain / 5) * 5;
      if (b > 0 && b < (tickSent[s.id] ?? Infinity)) {
        tickSent[s.id] = b;
        sync.tick(s.pid, b);
      }
    } else {
      if (!completedSent.has(s.id)) {
        completedSent.add(s.id);
        sync.complete(s.pid);
      }
      if (!announced.has(s.id)) {
        announced.add(s.id);
        announceReady(s.id, soundMode.value);
      }
    }
  }
}

// ---- 锁定 (首次默认解锁; 之后恢复上次状态, localStorage 持久化) ----
const locked = ref(localStorage.getItem("overlayLocked") === "1");
function toggleLock() {
  locked.value = !locked.value;
  localStorage.setItem("overlayLocked", locked.value ? "1" : "0");
  focusGame();
}

// ---- 多开 ----
const gameWins = ref([]);
const selHwnd = ref(0);
const winIdx = computed(() => gameWins.value.findIndex((w) => w.hwnd === selHwnd.value));
function cycleGameWin() {
  if (gameWins.value.length < 2) return;
  const next = gameWins.value[(winIdx.value + 1) % gameWins.value.length];
  if (next) invoke("select_game_window", { hwnd: next.hwnd });
}

// ---- 离开房间 (✕) ----
function leaveRoom() {
  sync.leave();
  emit("room-left");
  invoke("close_overlay");
}

// ---- 点击穿透: 可交互区域上报 (Rust 侧轮询光标切换整窗穿透) ----
let lastRegionsJson = "";
let regionTimer = null;
function activeRegionSel() {
  // 锁定: 格子+按钮可点, 背景穿透; 解锁: 整个面板
  return locked.value ? ".cell, .lockbtn, .minibtn" : ".panel";
}
function pushRegionsNow() {
  if (!isTauri) return;
  const rects = [];
  for (const el of document.querySelectorAll(activeRegionSel())) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      rects.push({ x: r.x - 2, y: r.y - 2, w: r.width + 4, h: r.height + 4 });
    }
  }
  const json = JSON.stringify(rects);
  if (json === lastRegionsJson) return;
  lastRegionsJson = json;
  window.__TAURI__.core.invoke("set_hit_regions", { rects }).catch(() => {});
}
function schedulePushRegions() {
  nextTick(() => {
    requestAnimationFrame(pushRegionsNow);
  });
}
watch([locked, uiScale, locale, () => gameWins.value.length], schedulePushRegions);

// ---- 自定义拖拽 (不走 OS 拖拽循环 → 方向键等游戏按键不影响) ----
let dragStart = null; // {sx, sy(屏幕), wx, wy(窗口逻辑位置)}
function onPanelMouseDown(e) {
  if (!isTauri || locked.value || e.button !== 0) return;
  if (e.target.closest("button, .cell")) return;
  const cur = window.__TAURI__.window.getCurrentWindow();
  Promise.all([cur.outerPosition(), cur.scaleFactor()]).then(([pos, scale]) => {
    dragStart = { sx: e.screenX, sy: e.screenY, wx: pos.x / scale, wy: pos.y / scale };
  });
}
function onWindowMouseMove(e) {
  if (!dragStart) return;
  const dx = e.screenX - dragStart.sx;
  const dy = e.screenY - dragStart.sy;
  invoke("set_window_pos", { x: Math.round(dragStart.wx + dx), y: Math.round(dragStart.wy + dy) });
}
function stopDrag() {
  dragStart = null;
}
// 点击格子瞬间把焦点还给游戏
function onCellsDown() {
  focusGame();
}

// ---- 上报面板渲染尺寸 (gBCR, 已含 zoom) ----
// 尺寸闭环: Rust 下发 gameFactor → 前端 zoom 面板 → 上报渲染尺寸 → Rust 设窗口大小
// 双重 rAF 确保测量发生在 zoom 应用+浏览器渲染之后
async function reportBaseSize() {
  await nextTick();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const el = document.querySelector(".panel");
      if (el) {
        const r = el.getBoundingClientRect();
        invoke("set_panel_base", { width: Math.ceil(r.width), height: Math.ceil(r.height) });
      }
    });
  });
}
// 所有尺寸相关变化 (含 mount 时拉取的 gameFactor) 统一走 watch, 不手动调用避免竞态
watch([locked, uiScale, gameFactor, locale, () => gameWins.value.length], reportBaseSize, { flush: "post" });

// ---- 生命周期 ----
let unlisteners = [];
onMounted(async () => {
  preloadVoices();
  window.__bt = { sync, starts, locked }; // 调试钩子
  tickTimer = setInterval(() => {
    nowRef.value = Date.now();
    pollReady();
  }, 100);
  window.addEventListener("mousemove", onWindowMouseMove);
  window.addEventListener("mouseup", stopDrag);
  window.addEventListener("blur", stopDrag);
  regionTimer = setInterval(pushRegionsNow, 1000);
  if (isTauri) {
    try {
      const { listen } = window.__TAURI__.event;
      unlisteners.push(
        await listen("game_windows", (e) => {
          gameWins.value = e.payload?.windows || [];
          selHwnd.value = e.payload?.selected || 0;
        })
      );
      unlisteners.push(
        await listen("panel_scale", (e) => {
          const f = e.payload?.factor;
          if (typeof f === "number" && f > 0 && f !== gameFactor.value) {
            gameFactor.value = f;
          }
        })
      );
      unlisteners.push(
        await listen("settings-changed", reloadAppearance)
      );
      // 主动拉取缩放系数: 悬浮窗创建时 WebView 未就绪, panel_scale 事件可能已丢失
      // (拉取后由 watch 统一触发尺寸上报, 不手动调用)
      try {
        const f = await window.__TAURI__.core.invoke("get_panel_scale");
        if (typeof f === "number" && f > 0) gameFactor.value = f;
      } catch {
        /* 拉取失败保持 1, 事件会兜底 */
      }
      pushRegionsNow();
    } catch (err) {
      console.error(err);
    }
  }
});
onBeforeUnmount(() => {
  clearInterval(tickTimer);
  clearInterval(regionTimer);
  unlisteners.forEach((u) => u?.());
  window.removeEventListener("mousemove", onWindowMouseMove);
  window.removeEventListener("mouseup", stopDrag);
  window.removeEventListener("blur", stopDrag);
});
</script>

<template>
  <div class="overlaywin" :style="{ '--panel-alpha': panelOpacity }">
    <!-- 计时面板: [锁] [主体×4] ┃ [分身×2] [多开][✕] -->
    <div class="panel" :style="{ zoom: panelZoom }" @mousedown="onPanelMouseDown">
      <button
        class="lockbtn"
        :class="locked ? 'on' : 'off'"
        :title="locked ? t('lockOnTip') : t('lockOffTip')"
        @click="toggleLock"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" fill="currentColor" stroke="none" />
          <path v-if="locked" d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
          <path v-else d="M8 10.5V7a4 4 0 0 1 7.7-1.4" />
        </svg>
      </button>

      <div class="cells" @mousedown.capture="onCellsDown">
        <TimerCell
          v-for="i in 4"
          :key="SKILLS[i - 1].id"
          :skill="SKILLS[i - 1]"
          :state="stateOf(SKILLS[i - 1])"
          @start="start(i - 1)"
          @reset="reset(i - 1)"
        />
      </div>
      <span class="gdiv" :title="t('groupMain')"></span>
      <div class="cells" @mousedown.capture="onCellsDown">
        <TimerCell
          v-for="i in 2"
          :key="SKILLS[i + 3].id"
          :skill="SKILLS[i + 3]"
          :state="stateOf(SKILLS[i + 3])"
          @start="start(i + 3)"
          @reset="reset(i + 3)"
        />
      </div>

      <button
        v-if="gameWins.length > 1"
        class="minibtn"
        :title="`${t('trackClient')} ${winIdx + 1}/${gameWins.length} (${t('clickSwitch')})`"
        @click="cycleGameWin"
      >
        {{ winIdx + 1 }}/{{ gameWins.length }}
      </button>
      <button class="minibtn" :title="t('leave')" @click="leaveRoom">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
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
  background: transparent;
}

.overlaywin {
  height: 100vh;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
}

/* ---- 计时面板 (紧凑: 经 CSS 变量覆盖 TimerCell 默认尺寸) ---- */
.panel {
  --cell-min-w: 56px;
  --cell-pad: 3px 4px 2px;
  --name-fs: 11px;
  --time-fs: 17px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  border-radius: 10px;
  background: rgba(10, 12, 18, var(--panel-alpha, 0.85));
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.cells {
  display: flex;
  gap: 4px;
}
.gdiv {
  width: 1px;
  align-self: stretch;
  margin: 2px 3px;
  background: rgba(255, 255, 255, 0.22);
  border-radius: 1px;
}
/* 锁图标按钮 */
.lockbtn {
  width: 16px;
  height: 16px;
  border-radius: 5px;
  border: none;
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}
.lockbtn.on {
  color: #69f0ae;
}
.lockbtn.off {
  color: #ffb74d;
}
.lockbtn:hover {
  background: rgba(255, 255, 255, 0.16);
}
/* 小按钮 */
.minibtn {
  border: none;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.7);
  font-size: 10px;
  font-weight: 600;
  font-family: Consolas, monospace;
  border-radius: 6px;
  padding: 3px 5px;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.minibtn:hover {
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
}
</style>
