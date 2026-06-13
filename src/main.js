/**
 * main.js — 入口,組裝 app(設計 §4.1 / §4.2)。
 *
 * 職責:抓 DOM(video / canvas / UI 掛載點)、用 config 建立所有模組、
 * 接好回呼(handTracking → tips 緩存、ui.onChange → musicEngine/audioEngine)、
 * 顯示「開始」覆蓋,使用者點擊後 app.start()。
 *
 * 這裡是唯一接觸全域 DOM 與 import 全部模組的地方;其餘模組彼此只透過契約相依。
 */

import {
  DISKS,
  DEFAULT_KEY,
  DEFAULT_SCALE,
  BPM,
  GROOVE_DEFAULT_ON,
} from './config.js';
import { createCamera } from './camera.js';
import { createHandTracker } from './handTracking.js';
import { createMapper } from './coordinateMapper.js';
import { createMusicEngine } from './musicEngine.js';
import { createAudioEngine } from './audioEngine.js';
import { createRenderer } from './renderer.js';
import { createUI } from './ui.js';
import { createApp } from './app.js';

// 1) 取 DOM。
const video = /** @type {HTMLVideoElement} */ (document.getElementById('cam-video'));
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('scene'));
const topbar = document.getElementById('ui-topbar');
const hint = document.getElementById('ui-hint');
const overlay = document.getElementById('ui-overlay');

// 2) 建模組。app 以閉包持有,讓 handTracker.onResults 與 ui.onChange 能轉發給它。
/** @type {ReturnType<typeof createApp>} */
let app;

const camera = createCamera({ video, mirror: true });
const musicEngine = createMusicEngine({ key: DEFAULT_KEY, scale: DEFAULT_SCALE });
const audioEngine = createAudioEngine();
const mapper = createMapper({ disks: DISKS });
const renderer = createRenderer({ canvas, disks: DISKS });

// handTracking 在建構時固定 onResults;轉發到 app 的 tips 緩存(設計 §5)。
const handTracker = createHandTracker({
  video,
  onResults: (frame) => {
    if (app) app.setHandFrame(frame);
  },
});

// ui.onChange 轉發到 app 套用(musicEngine / audioEngine + 回灌 ui)。
const ui = createUI({
  root: { topbar, hint, overlay },
  onChange: (change) => {
    if (app) app.applyChange(change);
  },
});

// 3) 組裝 app。
app = createApp({
  video,
  canvas,
  camera,
  handTracker,
  mapper,
  musicEngine,
  audioEngine,
  renderer,
  ui,
});

// 4) 初始狀態回灌 UI(控制列顯示與真相同步)。
ui.setScale(DEFAULT_SCALE);
ui.setKey(DEFAULT_KEY);
ui.setGroove(GROOVE_DEFAULT_ON, BPM);
ui.setStatus('idle');

// 5) 顯示「開始」覆蓋;點擊 = 使用者手勢 → 解鎖 audio + 啟相機 + 跑迴圈(設計 §8)。
ui.showStart(() => {
  app.start();
});

// 6) viewport 改變 → 重設 canvas 像素尺寸與 cover 變換。
window.addEventListener('resize', () => {
  renderer.resize();
});
