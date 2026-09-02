<script setup>
// 窗口分流: main = 主客户端(大厅/设置), overlay = 悬浮窗(计时面板)
// 纯浏览器打开(开发预览) = 主窗口视图
import { computed, onMounted, ref } from "vue";
import MainWin from "./MainWin.vue";
import OverlayWin from "./OverlayWin.vue";

const isTauri = !!window.__TAURI__;
const label = ref(isTauri ? null : "main");

onMounted(async () => {
  if (isTauri) {
    try {
      label.value = window.__TAURI__.window.getCurrentWindow().label || "main";
    } catch {
      label.value = "main";
    }
  }
});

const view = computed(() => {
  if (label.value === "overlay") return OverlayWin;
  return MainWin;
});
</script>

<template>
  <component :is="view" />
</template>
