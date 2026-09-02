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
    soundMode: "就绪提示",
    voice: "语音播报",
    beep: "提示音",
    mute: "静音",
    opacity: "背景不透明度",
    scale: "界面缩放",
    language: "语言",
    resetDefaults: "恢复默认",
    done: "完成",
    settingsHint: "设置保存在本机, 即时生效; 队友互不影响。",
    lockOnTip: "锁定中: 点击穿透 (解锁可拖拽/点击)",
    lockOffTip: "已解锁: 可拖拽, 单击计时, 双击重置",
    dragTip: "拖动面板",
    groupMain: "主体 | 分身",
    timersSection: "计时器",
    settingsSection: "设置",
    backToGame: "回到游戏",
    roomInfo: "房间",
    checkUpdate: "检查更新",
    checking: "检查中…",
    upToDate: "已是最新版本",
    newVersion: "新版本",
    download: "下载",
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
    soundMode: "Ready alert",
    voice: "Voice",
    beep: "Beep",
    mute: "Mute",
    opacity: "Background opacity",
    scale: "UI scale",
    language: "Language",
    resetDefaults: "Reset defaults",
    done: "Done",
    settingsHint: "Saved locally, applies instantly.",
    lockOnTip: "Locked: click-through (unlock to drag/click)",
    lockOffTip: "Unlocked: drag, click to start, double-click to reset",
    dragTip: "Drag panel",
    groupMain: "Main | Clone",
    timersSection: "Timers",
    settingsSection: "Settings",
    backToGame: "Back to game",
    roomInfo: "Room",
    checkUpdate: "Check update",
    checking: "Checking…",
    upToDate: "Up to date",
    newVersion: "New version",
    download: "Download",
    stConnecting: "Connecting…",
    stConnected: "Synced",
    stReconnecting: "Reconnecting…",
    stFailed: "Failed",
  },
};

export const locale = ref(localStorage.getItem("locale") || "zh");

export function t(key) {
  return dict[locale.value]?.[key] ?? dict.zh[key] ?? key;
}

export function setLocale(l) {
  locale.value = l;
  localStorage.setItem("locale", l);
}

// 多窗口同步: localStorage 变化时刷新 (Tauri 双窗口内存不共享)
export function reloadLocale() {
  const saved = localStorage.getItem("locale");
  if (saved && saved !== locale.value) {
    locale.value = saved;
  }
}

export function skillLabel(s) {
  return locale.value === "en" && s.labelEn ? s.labelEn : s.label;
}
