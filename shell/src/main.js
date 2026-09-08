import { createApp } from "vue";
import App from "./App.vue";

// 禁用右键菜单 (WebView2 默认浏览器式菜单; main.js 是主窗口/悬浮窗共用入口)
document.addEventListener("contextmenu", (e) => e.preventDefault());

createApp(App).mount("#app");
