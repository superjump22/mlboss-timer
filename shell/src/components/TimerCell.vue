<script setup>
import { computed, ref } from "vue";
import { skillLabel } from "../i18n.js";

const props = defineProps({
  skill: Object, // {id,label,labelEn,cd,warn,color}
  state: Object, // {phase:'idle'|'run'|'ready', remain}
});
const emit = defineEmits(["start", "reset"]);

const label = computed(() => skillLabel(props.skill));

const display = computed(() => {
  const s = props.state;
  if (!s || s.phase === "idle") return { text: String(props.skill.cd), cls: "idle" };
  if (s.phase === "ready") return { text: String(props.skill.cd), cls: "ready" };
  const r = Math.ceil(s.remain);
  if (s.remain <= props.skill.warn) return { text: String(r), cls: "warn" };
  return { text: String(r), cls: "run" };
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
    :class="[display.cls, { pressed }]"
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
  min-width: var(--cell-min-w, 78px);
  padding: var(--cell-pad, 6px 8px 5px);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.055);
  cursor: pointer;
  user-select: none;
  text-align: center;
  transition: background 0.12s;
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
}
.time {
  font: 700 var(--time-fs, 24px)/1.15 Consolas, "Cascadia Mono", monospace;
  color: #eef0f4;
  font-variant-numeric: tabular-nums;
}
/* 预警: 红色呼吸 */
.cell.warn .time {
  animation: blink-warn 0.8s ease-in-out infinite;
}
@keyframes blink-warn {
  0%, 100% { color: #ff5c5c; text-shadow: 0 0 10px rgba(255, 92, 92, 0.55); }
  50% { color: rgba(255, 92, 92, 0.5); text-shadow: none; }
}
/* 就绪: 从静止开始闪 3 次 (红色警示), 结束后完全回落 */
.cell.ready {
  animation: glow-ready 0.8s ease-in-out 3;
}
@keyframes glow-ready {
  0%, 100% { background: rgba(255, 255, 255, 0.055); box-shadow: none; }
  50% { background: rgba(255, 92, 92, 0.32); box-shadow: 0 0 12px rgba(255, 92, 92, 0.35); }
}
</style>
