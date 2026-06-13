/**
 * handTracking.js — 手部追蹤 I/O 邊界,依賴 MediaPipe Hands(設計 §4.1 / §2.1 / §2.4 / §8)。
 *
 * 職責:對 <video> 每幀跑 MediaPipe Hands,抽出**食指尖(landmark 8)**的
 * normalized 座標,經 onResults 回呼上拋。**不辨識手勢/骨架語意**,只讀座標點
 * (設計核心決策:使用者過去踩雷,只讀單點)。
 *
 * 分盤靠「螢幕左右位置」(在 coordinateMapper 處理),此處附帶 handedness 僅供參考、
 * 不作為分盤依據(設計 §2.1)。
 *
 * 座標未鏡像:輸出 MediaPipe 原始 normalized 0..1;鏡像由 mapper 的分盤環節處理
 * (設計 §2.1)。故 selfieMode 必須關閉,否則會與 mapper 的 (1-x) 反鏡像雙重翻轉。
 */

// 注意:@mediapipe/hands 是 UMD 函式庫(把建構子掛上全域 window.Hands),不是正規 ESM。
// 用 Vite 的 `import { Hands }` 打包後會得到 undefined(真機 new Hands() 直接爆),
// 故改由 index.html 的 CDN <script> 載入,執行期於 start() 由 window.Hands 取得建構子。
import { HAND_TRACKER, DETECT_EVERY_N_FRAMES } from './config.js';

/**
 * MediaPipe Hands 的執行期資產(.wasm / .data / .tflite / .binarypb / loader.js)
 * 無法被 Vite/Rollup 靜態打包(套件以 import.meta.url 動態解析同層檔)。原型策略(設計
 * §0「CDN 載模型」、§7 Ops、§8「CDN」失敗路徑):import Hands 類別由 Vite 打包,但執行期
 * 資產一律從 jsDelivr 取,並 pin 到「實際安裝的版本」確保可重現與 class/asset 相容。
 *
 * @see package.json 的 @mediapipe/hands 版本必須與此一致。
 */
const MEDIAPIPE_VERSION = '0.4.1675469240';
const ASSET_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${MEDIAPIPE_VERSION}`;

/**
 * @callback OnResults
 * @param {{
 *   hands: Array<{
 *     indexTip: {x:number, y:number},   // 食指尖 normalized 0..1(未鏡像)
 *     handedness: 'Left'|'Right',        // MediaPipe 標籤,僅參考(不用於分盤)
 *     landmarks: Array<{x:number,y:number,z:number}>  // 完整 21 點 normalized(備用)
 *   }>
 * }} frame
 * @returns {void}
 */

/**
 * 建立手部追蹤器。
 * @param {Object} opts
 * @param {HTMLVideoElement} opts.video 已在播放的 <video>(相機畫面來源)
 * @param {OnResults} opts.onResults 每幀偵測結果回呼(非同步;app 緩存最新一筆)
 * @returns {{
 *   start: () => Promise<void>,  // 載入模型 + 啟動逐幀偵測;模型載入失敗 throw(供 UI retry)
 *   stop: () => void             // 停止偵測迴圈
 * }} tracker
 *
 * @remarks 偵測參數見 config.HAND_TRACKER(maxNumHands=2 等);效能不足時以
 *   config.DETECT_EVERY_N_FRAMES 隔幀偵測(設計 §2.4 / §8)。
 */
export function createHandTracker({ video, onResults }) {
  const { indexTipLandmark } = HAND_TRACKER;

  /** @type {any} MediaPipe Hands 實例(initialize 後可用;建構子來自全域 window.Hands) */
  let hands = null;
  /** @type {number|null} rAF handle;null 表示偵測迴圈未在跑 */
  let rafId = null;
  /** 是否已收到 stop():用來在非同步縫隙中止迴圈,避免停止後又排下一幀 */
  let running = false;
  /** send() 為非同步,前一幀未完成前不重送,避免 MediaPipe graph 併發錯誤 */
  let inFlight = false;
  /** 幀計數器,配合 detectEvery 做隔幀偵測 */
  let frameCount = 0;
  /**
   * 有效隔幀數(預設取 config;app 可依執行期 FPS 動態調高,設計 §8:FPS 過低 → 每 N 幀偵測)。
   */
  let detectEvery = Math.max(1, DETECT_EVERY_N_FRAMES);

  /**
   * 把 MediaPipe 原始 results 轉成本模組對外的 frame 形狀(只挑 landmark 8 當 indexTip)。
   * @param {import('@mediapipe/hands').Results} results
   * @returns {{hands: Array<{indexTip:{x:number,y:number}, handedness:'Left'|'Right', landmarks:Array<{x:number,y:number,z:number}>}>}}
   */
  function toFrame(results) {
    const multi = (results && results.multiHandLandmarks) || [];
    const handedness = (results && results.multiHandedness) || [];
    const out = [];
    for (let i = 0; i < multi.length; i++) {
      const landmarks = multi[i];
      const tip = landmarks && landmarks[indexTipLandmark];
      if (!tip) continue; // 沒有食指尖點就略過該手(防禦不完整偵測)
      out.push({
        indexTip: { x: tip.x, y: tip.y }, // normalized 0..1,未鏡像
        handedness: (handedness[i] && handedness[i].label) || 'Right',
        landmarks,
      });
    }
    return { hands: out };
  }

  /**
   * 單幀偵測迴圈:依 rAF 驅動,隔幀送圖給 MediaPipe。
   * 用 inFlight 旗標確保同一時間只有一張在 graph 內處理。
   */
  function loop() {
    if (!running) return;
    rafId = requestAnimationFrame(loop);

    // 隔幀偵測(設計 §8:FPS 過低時調高 N);N<=1 等同每幀。
    frameCount = (frameCount + 1) % detectEvery;
    if (frameCount !== 0) return;

    // 前一幀尚在處理,或 video 尚無有效畫面 → 跳過,等下一輪 rAF。
    if (inFlight || !hands) return;
    if (!video || video.readyState < 2 /* HAVE_CURRENT_DATA */) return;

    inFlight = true;
    hands
      .send({ image: video })
      .catch(() => {
        // 單幀送圖失敗不致命(可能畫面瞬時無效);忽略,下一幀續跑。
      })
      .finally(() => {
        inFlight = false;
      });
  }

  /**
   * 載入模型並開始偵測迴圈。
   * @returns {Promise<void>}
   * @throws {Error} 模型/資產載入失敗(CDN 不可用、資產 404 等),供 UI 顯示 retry。
   */
  async function start() {
    if (running) return; // 已在跑,冪等

    try {
      // @mediapipe/hands 為 UMD,建構子掛在全域(由 index.html 的 CDN <script> 載入)。
      const HandsCtor =
        (typeof window !== 'undefined' && window.Hands) ||
        (typeof globalThis !== 'undefined' && globalThis.Hands);
      if (typeof HandsCtor !== 'function') {
        throw new Error('MediaPipe Hands 函式庫尚未載入(CDN <script> 可能被網路或擴充套件阻擋)');
      }
      hands = new HandsCtor({
        // 把資產路徑導到 CDN(見 ASSET_BASE 註解)。
        locateFile: (file) => `${ASSET_BASE}/${file}`,
      });
      hands.setOptions({
        selfieMode: false, // 必須關:鏡像由 mapper 處理(設計 §2.1)
        maxNumHands: HAND_TRACKER.maxNumHands,
        modelComplexity: HAND_TRACKER.modelComplexity,
        minDetectionConfidence: HAND_TRACKER.minDetectionConfidence,
        minTrackingConfidence: HAND_TRACKER.minTrackingConfidence,
      });
      hands.onResults((results) => {
        // 停止後可能仍有殘留 callback,丟棄之。
        if (!running) return;
        try {
          onResults(toFrame(results));
        } catch (err) {
          // 上層回呼出錯不應拖垮偵測迴圈。
          console.error('[handTracking] onResults callback error:', err);
        }
      });

      // 主動 initialize:把「模型/資產載入失敗」收斂在 start() 一處 throw(設計 §8)。
      await hands.initialize();
    } catch (err) {
      // 清掉半成品實例,讓 retry 可重建。
      try {
        if (hands) await hands.close();
      } catch {
        /* 忽略清理錯誤 */
      }
      hands = null;
      throw new Error(
        `MediaPipe Hands 模型載入失敗(可能為網路 / CDN 問題):${err && err.message ? err.message : err}`,
      );
    }

    running = true;
    inFlight = false;
    frameCount = 0;
    loop();
  }

  /** 停止偵測迴圈並釋放 MediaPipe 實例。 */
  function stop() {
    running = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (hands) {
      // close 為非同步;不 await(stop 為同步介面),但釋放 graph 資源。
      hands.close().catch(() => {
        /* 忽略關閉錯誤 */
      });
      hands = null;
    }
  }

  /**
   * 動態設定隔幀偵測數(設計 §8:FPS 過低 → 每 N 幀偵測一次)。
   * @param {number} n >=1 的整數
   */
  function setDetectEvery(n) {
    detectEvery = Math.max(1, Math.round(n) || 1);
  }

  return { start, stop, setDetectEvery };
}
