// 轻量 i18n: 字典 + t(); 语言持久化 localStorage
import { ref } from "vue";

const dict = {
  zh: {
    appTitle: "MapleLegends Boss Timer",
    quickCreate: "快速建房",
    join: "加入房间",
    roomCodePh: "房间码",
    lobbyHint: "可与 bossassis.com 网页版同步",
    roomErr: "房间码为 4-6 位字母数字",
    copied: "已复制",
    copyRoom: "点击复制房间码",
    retry: "重试",
    netFailed: "网络连接失败 · 点击重试",
    leave: "离开",
    leaveRoom: "离开房间",
    trackClient: "跟踪客户端",
    clickSwitch: "点击切换",
    settings: "设置",
    unlockKey: "解锁热键",
    pressKey: "按下按键…",
    unset: "未设置",
    soundMode: "就绪提示音",
    voice: "语音播报",
    beep: "提示音",
    mute: "静音",
    readyFx: "就绪提示",
    fxBlink: "闪 3 次",
    fxBlinkLong: "持续闪烁",
    fxBar: "计时进度条",
    opacity: "背景不透明度",
    scale: "界面缩放",
    timeFmt: "时间格式",
    timeFmtMs: "分秒 (5:00)",
    timeFmtSec: "秒数 (300)",
    offsetLabel: "偏移",
    offsetTip: "所有技能计时上限减去该秒数（下限 5s），全房间同步；未进房时设置为下次建房/进空房的默认值",
    offsetApply: "应用",
    offsetErr: "请输入 0-30 的整数",
    offsetApplied: "已应用 {n}s 偏移",
    offsetSaved: "已保存 {n}s · 下次建房生效",
    offsetAuto: "已自动应用上次 {n}s",
    offsetSynced: "已同步房间偏移 {n}s",
    offsetUnchanged: "偏移值未改变",
    language: "语言",
    resetDefaults: "恢复默认",
    done: "完成",
    lockOnTip: "锁定中: 点击穿透 (解锁可拖拽/点击)",
    lockOffTip: "已解锁: 可拖拽, 单击计时, 双击重置",
    dragTip: "拖动面板",
    groupMain: "主体 | 分身",
    timersSection: "计时器",
    settingsSection: "设置",
    selectBossTitle: "选择 Boss 计时器",
    back: "返回",
    ghDownload: "手动下载",
    skillCount: "{n} 个技能",
    showSupport: "显示支援技能",
    on: "显示",
    off: "隐藏",
    pbGroupRes: "复活术",
    pbGroupTl: "伺机待发",
    namesPh: "名字",
    namesSave: "保存名字",
    namesSaved: "名字已保存",
    backToGame: "回到游戏",
    roomInfo: "房间",
    checkUpdate: "检查更新",
    checking: "检查中…",
    checkFailed: "检查失败",
    upToDate: "已是最新版本",
    newVersion: "新版本",
    updateNow: "立即更新",
    installRestart: "安装并重启",
    downloadFailed: "下载失败",
    stConnecting: "连接中…",
    stConnected: "已同步",
    stReconnecting: "重连中…",
    stFailed: "连接失败",
  },
  en: {
    appTitle: "MapleLegends Boss Timer",
    quickCreate: "Create Room",
    join: "Join Room",
    roomCodePh: "Room code",
    lobbyHint: "Syncs with bossassis.com web clients",
    roomErr: "Room code: 4-6 letters/digits",
    copied: "Copied",
    copyRoom: "Click to copy room code",
    retry: "Retry",
    netFailed: "Connection failed · click to retry",
    leave: "Leave",
    leaveRoom: "Leave room",
    trackClient: "Client",
    clickSwitch: "click to switch",
    settings: "Settings",
    unlockKey: "Unlock hotkey",
    pressKey: "Press a key…",
    unset: "Not set",
    soundMode: "Ready sound",
    voice: "Voice",
    beep: "Beep",
    mute: "Mute",
    readyFx: "Ready highlight",
    fxBlink: "3 blinks",
    fxBlinkLong: "Blinking",
    fxBar: "Countdown bar",
    opacity: "Background opacity",
    scale: "UI scale",
    timeFmt: "Time format",
    timeFmtMs: "M:SS (5:00)",
    timeFmtSec: "Seconds (300)",
    offsetLabel: "Offset",
    offsetTip: "Reduces every timer duration by this many seconds (min 5s), synced room-wide. Outside a room, it becomes the default for new rooms you create or join.",
    offsetApply: "Apply",
    offsetErr: "Enter an integer 0-30",
    offsetApplied: "Applied {n}s",
    offsetSaved: "Saved {n}s for new rooms",
    offsetAuto: "Auto-applied {n}s",
    offsetSynced: "Synced room offset {n}s",
    offsetUnchanged: "Offset unchanged",
    language: "Language",
    resetDefaults: "Reset defaults",
    done: "Done",
    lockOnTip: "Locked: click-through (unlock to drag/click)",
    lockOffTip: "Unlocked: drag, click to start, double-click to reset",
    dragTip: "Drag panel",
    groupMain: "Main | Clone",
    timersSection: "Timers",
    settingsSection: "Settings",
    selectBossTitle: "Select boss timer",
    back: "Back",
    ghDownload: "Manual download",
    skillCount: "{n} skills",
    showSupport: "Support skills",
    on: "Show",
    off: "Hide",
    pbGroupRes: "Resurrection",
    pbGroupTl: "Time Leap",
    namesPh: "Name",
    namesSave: "Save names",
    namesSaved: "Names saved",
    backToGame: "Back to game",
    roomInfo: "Room",
    checkUpdate: "Check update",
    checking: "Checking…",
    checkFailed: "Check failed",
    upToDate: "Up to date",
    newVersion: "New version",
    updateNow: "Update now",
    installRestart: "Install & restart",
    downloadFailed: "Download failed",
    stConnecting: "Connecting…",
    stConnected: "Synced",
    stReconnecting: "Reconnecting…",
    stFailed: "Failed",
  },
};

export const locale = ref(localStorage.getItem("locale") || "zh");

// 语言与时间格式均 per-boss (彻底隔离, 无共享设置)
// locale_{boss} → 旧全局 locale (一次性迁移) → zh; timeFmt_{boss} → boss 原版默认
import { timeFmtOf, activeBossId } from "./bosses.js";
export function localeOf(bossId) {
  return localStorage.getItem(`locale_${bossId}`) || localStorage.getItem("locale") || "zh";
}
locale.value = localeOf(activeBossId());
export const timeFmt = ref(timeFmtOf(activeBossId()));

export function t(key) {
  return dict[locale.value]?.[key] ?? dict.zh[key] ?? key;
}

export function setLocale(l) {
  locale.value = l;
  localStorage.setItem("locale", l);
}

// 多窗口同步: localStorage 变化时刷新 (Tauri 双窗口内存不共享; 悬浮窗锁定自己的 boss)
export function reloadLocale() {
  const l = localeOf(activeBossId());
  if (l !== locale.value) {
    locale.value = l;
  }
  const fmt = timeFmtOf(activeBossId());
  if (fmt !== timeFmt.value) {
    timeFmt.value = fmt;
  }
}

export function skillLabel(s) {
  return locale.value === "en" && s.labelEn ? s.labelEn : s.label;
}
