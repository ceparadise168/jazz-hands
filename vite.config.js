import { defineConfig } from 'vite';

// HandSing 純前端原型。Vite 預設 root = 專案根、index.html 為入口。
// MediaPipe Hands 與 Tone.js 走 npm 依賴,Vite 自動打包。
export default defineConfig({
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    // vitest:純邏輯模組(geometry / coordinateMapper / musicEngine)為 node 環境即可
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
});
