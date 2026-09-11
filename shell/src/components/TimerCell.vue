<script setup>
import { computed, ref } from "vue";
import { skillLabel, timeFmt } from "../i18n.js";

const props = defineProps({
  skill: Object, // {id,label,labelEn,cd,warn,color,nameable?}
  state: Object, // {phase:'idle'|'run'|'ready', remain}
  effcd: { type: Number, default: 0 }, // 含 offset 的有效 CD (未传/0 时用 skill.cd)
  name: { type: String, default: "" }, // PB 可命名格子的自定义名字 (空 = 显示占位符)
  tint: { type: String, default: "" }, // HT 部位背景色 (左手暖/中头紫/右手冷)
  fx: { type: String, default: "low" }, // 就绪提示强度: low=闪3次 | mid=持续闪 | high=进度条
});
const emit = defineEmits(["start", "reset"]);

// 有自定义名字显示名字, 否则按语言显示 label (PB 名字格的 label 即占位符 R1/TL1)
const label = computed(() => props.name || skillLabel(props.skill));
// idle/ready 显示值: offset 生效时为 max(5, 原始CD - offset)
const eff = computed(() => (props.effcd > 0 ? props.effcd : props.skill.cd));

// 时间显示: 全局偏好 "ms" = 分秒 (30:00/5:00/0:55), "sec" = 纯秒数 (300/55)
function fmt(sec) {
  const s = Math.max(0, Math.round(sec));
  if (timeFmt.value !== "sec" && eff.value >= 60) {
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  return String(s);
}

// 高挡进度条: 剩余比例 0~1 (计时中实时; 驱动从上到下的绿色填充)
const progress = computed(() => {
  const s = props.state;
  if (!s || s.phase !== "run") return null;
  return Math.max(0, Math.min(1, s.remain / eff.value));
});

const display = computed(() => {
  const s = props.state;
  if (!s || s.phase === "idle") return { text: fmt(eff.value), cls: "idle" };
  if (s.phase === "ready") return { text: fmt(eff.value), cls: "ready" };
  if (s.remain <= props.skill.warn) return { text: fmt(Math.ceil(s.remain)), cls: "warn" };
  return { text: fmt(Math.ceil(s.remain)), cls: "run" };
});

// 背景策略: 高挡计时中 = 进度条 (--p 驱动); 就绪时让位给 CSS 就绪效果 (避免 tint 内联背景盖住高亮)
const bgStyle = computed(() => {
  const phase = props.state?.phase;
  if (phase === "ready") return undefined;
  if (progress.value !== null) return { "--p": progress.value };
  if (props.tint) return { background: props.tint };
  return undefined;
});

// 单击/双击判别: 260ms 内第二击 = 双击
let clickTimer = null;
const pressed = ref(false);
function onClick() {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    emit("reset"); // 双击: 重置并停止
  } else {
    clickTimer = setTimeout(() => {
      clickTimer = null;
      emit("start"); // 单击: 开始/重开
    }, 260);
  }
}
</script>

<template>
  <div
    class="cell"
    :class="[display.cls, { pressed }, fx !== 'low' ? `fx-${fx}` : '']"
    :style="bgStyle"
    @mousedown="pressed = true"
    @mouseup="pressed = false"
    @mouseleave="pressed = false"
    @click="onClick"
  >
    <div class="top">
      <span class="name" :style="{ color: skill.color }">{{ label }}</span>
    </div>
    <div class="time">{{ display.text }}</div>
  </div>
</template>

<style scoped>
/* 尺寸用 CSS 变量: 外层(悬浮窗紧凑模式)可覆盖 */
.cell {
  width: var(--cell-w, auto); /* 固定宽: 同 boss 行内格子列对齐 (悬浮窗注入) */
  min-width: var(--cell-min-w, 78px);
  padding: var(--cell-pad, 6px 8px 5px);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.055);
  cursor: pointer;
  user-select: none;
  text-align: center;
  transition: background 0.12s;
  overflow: hidden;
}
.cell.pressed {
  background: rgba(255, 255, 255, 0.14);
}
.top {
  display: flex;
  justify-content: center;
  align-items: baseline;
  gap: 6px;
}
.name {
  font: 700 var(--name-fs, 13px)/1.2 "Segoe UI", "Microsoft YaHei UI", sans-serif;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis; /* PB 长名字截断, 不撑破固定宽格子 */
}
.time {
  font: 700 var(--time-fs, 24px)/1.15 Consolas, "Cascadia Mono", monospace;
  color: #eef0f4;
  font-variant-numeric: tabular-nums;
}
/* 预警: 红色呼吸 (文字; 与进度条背景共存) */
.cell.warn .time {
  animation: blink-warn 0.8s ease-in-out infinite;
}
@keyframes blink-warn {
  0%, 100% { color: #ff5c5c; text-shadow: 0 0 10px rgba(255, 92, 92, 0.55); }
  50% { color: rgba(255, 92, 92, 0.5); text-shadow: none; }
}

/* ---- 就绪提示强度 ---- */
/* 低 (默认): 绿色高亮闪 3 次后回落 */
.cell.ready {
  animation: glow-ready 0.8s ease-in-out 3;
}
@keyframes glow-ready {
  0%, 100% { background: rgba(255, 255, 255, 0.055); box-shadow: none; }
  50% { background: rgba(74, 222, 128, 0.32); box-shadow: 0 0 12px rgba(74, 222, 128, 0.4); }
}
/* 中: 持续闪烁不回落 */
.cell.fx-mid.ready {
  animation: glow-ready 0.8s ease-in-out infinite;
}
/* 高: 计时中 = 从上到下的绿色进度条 (--p = 剩余比例); 就绪 = 与低挡相同 (闪 3 次回落) */
.cell.fx-high.run,
.cell.fx-high.warn {
  background: linear-gradient(
    to top,
    rgba(74, 222, 128, 0.28) calc(var(--p, 1) * 100%),
    rgba(255, 255, 255, 0.055) calc(var(--p, 1) * 100%)
  );
  transition: none; /* 填充逐秒平滑不必, 每 100ms 刷新; 过渡反而拖影 */
}
</style>
