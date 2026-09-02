import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// 部署目标: EdgeOne Pages (静态托管); public/ 下的 voices 会被自动复制到 dist
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173, // Tauri 壳 devUrl
  },
  build: {
    outDir: "dist",
  },
});
