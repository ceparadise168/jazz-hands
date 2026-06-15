/**
 * app.js — 主迴圈與串接(設計 §4.1 / §5)。
 *
 * 組裝所有模組、跑單一 requestAnimationFrame 迴圈,串起資料流(設計 §5):
 *
 *   camera.start()                         相機就緒
 *   handTracking.onResults → 緩存最新 tips(非同步)
 *   每幀(rAF):
 *     coordinateMapper.update(tips, viewport) → { L:{zone,changed}, R:{zone,changed} }
 *     diff vs 上一幀
 *       → musicEngine.chordForSlot / noteForSlot 查表
 *       → audioEngine.setChord / setMelodyNote / setGroove 發聲
 *       → renderer.draw(視覺回饋)
 *
 * 此模組是 I/O 編排(非純邏輯):持有最新 tips 緩存、上一幀狀態、rAF handle。
 */

import { CameraError } from './camera.js';
import { DESIGN_VIEW, BPM, GROOVE_DEFAULT_ON, SLOTS, KEYBOARD, FIST_HOLD_MS, melodyGeom } from './config.js';
import { bothHandsFist } from './gesture.js';

/**
 * 建立 app(尚未啟動;呼叫 start() 才真正開相機 + 偵測 + 迴圈)。
 * @param {Object} deps 已建立的相依模組與 DOM(由 main.js 注入,方便測試 mock)
 * @param {HTMLVideoElement} deps.video
 * @param {HTMLCanvasElement} deps.canvas
 * @param {ReturnType<import('./camera.js').createCamera>} deps.camera
 * @param {ReturnType<import('./handTracking.js').createHandTracker>} deps.handTracker
 * @param {ReturnType<import('./coordinateMapper.js').createMapper>} deps.mapper
 * @param {ReturnType<import('./musicEngine.js').createMusicEngine>} deps.musicEngine
 * @param {ReturnType<import('./audioEngine.js').createAudioEngine>} deps.audioEngine
 * @param {ReturnType<import('./renderer.js').createRenderer>} deps.renderer
 * @param {ReturnType<import('./ui.js').createUI>} deps.ui
 * @returns {{
 *   start: () => Promise<void>,   // 解鎖 audio → 開相機 → 啟偵測 → 跑 rAF 迴圈
 *   stop: () => void,             // 停迴圈 + 偵測 + 相機 + 釋放音訊
 *   setHandFrame: (frame: {hands: Array<{indexTip:{x:number,y:number}}>}) => void, // handTracking onResults 緩存入口
 *   applyChange: (change: import('./ui.js').UIChange) => void  // ui.onChange 套用入口
 * }} app
 */
export function createApp(deps) {
  const {
    video,
    camera,
    handTracker,
    mapper,
    musicEngine,
    audioEngine,
    renderer,
    ui,
  } = deps;

  /** 最新一筆手部偵測結果的 normalized 指尖陣列(非同步寫入,rAF 讀取)。 */
  let latestTips = [];

  /**
   * 偵測幀序號:setHandFrame(非同步 onResults)每收到一筆新偵測就 +1。
   * 主迴圈據此判斷 latestTips 是否「新鮮」——只有新鮮幀才推進 One-Euro 並用真實 dt,
   * 避免在無新偵測時對 stale 座標重跑濾波(dx=0 壓低 cutoff、徒增遲滯;設計 §2.4)。
   */
  let detectSeq = 0;
  let lastConsumedSeq = -1;
  /** 上一筆「被消費的偵測幀」時間戳(performance.now ms),用來量測真實 dt。 */
  let lastDetectTs = 0;
  /** 最近一次 mapper.update 的結果,供無新偵測幀時重用(僅重繪、不重跑濾波)。 */
  let lastResult = null;

  // ── 執行期 FPS 量測 → 動態調偵測頻率(設計 §8:FPS 過低 → 每 N 幀偵測一次)──
  let fpsEmaMs = 1000 / 60; // rAF 幀間隔指數移動平均(ms)
  let lastFrameTs = 0;
  let currentDetectEvery = 1;

  /** rAF handle;null 表示主迴圈未在跑。 */
  let rafId = null;

  /** 是否處於運作中(供 stop 中止非同步縫隙)。 */
  let looping = false;

  /** 伴奏律動狀態(真相;回灌 ui)。 */
  let grooveOn = GROOVE_DEFAULT_ON;
  let bpm = BPM;
  let melodyMode = KEYBOARD.defaultMode; // 右手排列模式(thirds / row)

  // ── 停止手勢(指揮家雙手握拳)──
  /** 最新一筆偵測「是否雙手握拳」(setHandFrame 更新)。 */
  let latestBothFists = false;
  /** 是否已停止演奏(latch:握拳 toggle 切換,維持到再次握拳)。 */
  let paused = false;
  /** 本輪「雙手握拳」起始時間(ms);0 = 目前非雙拳。 */
  let bothFistsSince = 0;
  /** 是否可觸發 toggle(放開雙拳後重新武裝;避免持續握拳連續切換)。 */
  let pauseArmed = true;

  // 上一幀的 L/R 狀態,做 diff(只在 changed 時打 audioEngine,設計 §5)。
  let prevL = { state: 'REST', zone: null };
  let prevR = { state: 'REST', zone: null };

  // 每盤塊標籤(和弦名 / 唱名),只在 key/scale 變更時重算(設計 §6 扇形標籤)。
  let chordLabels = [];
  let melodyLabels = [];
  rebuildSlotLabels();

  /** 依當前 musicEngine 的 key/scale 重算雙盤塊標籤。 */
  function rebuildSlotLabels() {
    chordLabels = [];
    melodyLabels = [];
    for (let k = 0; k < SLOTS; k++) {
      chordLabels.push(musicEngine.chordForSlot(k).name);
    }
    // melody 為 8 鍵(C..B + 高八度 C);標籤去掉科學音高的八度數字,如 C4/C5 → C。
    for (let k = 0; k < KEYBOARD.keys; k++) {
      melodyLabels.push(musicEngine.noteForSlot(k).name.replace(/-?\d+$/, ''));
    }
  }

  /**
   * handTracking.onResults 緩存入口(由 main.js 接上)。只存最新一筆,丟舊幀。
   * @param {{hands: Array<{indexTip:{x:number,y:number}}>}} frame
   */
  function setHandFrame(frame) {
    const hands = (frame && frame.hands) || [];
    latestTips = hands.map((hd) => hd.indexTip).filter(Boolean);
    // 停止手勢:本幀是否雙手握拳(用完整 landmarks 判;設計 §2.5 / gesture.js)。
    latestBothFists = bothHandsFist(hands);
    detectSeq++;
  }

  /**
   * ui.onChange 套用入口(由 main.js 接上):套到 musicEngine / audioEngine + 回灌 ui。
   * @param {import('./ui.js').UIChange} change
   */
  function applyChange(change) {
    if (!change || !change.type) return;
    switch (change.type) {
      case 'start':
        // 啟動由 main.js 的 showStart → app.start() 處理,此處不重複動作。
        break;
      case 'scale':
        musicEngine.setScale(change.scale);
        rebuildSlotLabels();
        ui.setScale(musicEngine.getScale());
        break;
      case 'key':
        musicEngine.setKey(change.key);
        rebuildSlotLabels();
        ui.setKey(musicEngine.getKey());
        break;
      case 'groove':
        grooveOn = !!change.groove;
        if (!paused) audioEngine.setGroove(grooveOn, bpm); // 停止中只存設定,繼續時才套用
        ui.setGroove(grooveOn, bpm);
        break;
      case 'bpm':
        bpm = change.bpm;
        if (!paused) audioEngine.setGroove(grooveOn, bpm);
        break;
      case 'instrument':
        audioEngine.setInstrument(change.chordInst, change.melodyInst);
        break;
      case 'layout': {
        melodyMode = change.mode;
        const kb = melodyGeom(melodyMode);
        mapper.setKeyboard(kb);
        renderer.setKeyboard(kb);
        break;
      }
      case 'dwellDiff':
        mapper.setDwell(change.ms, undefined);
        break;
      case 'dwellSame':
        mapper.setDwell(undefined, change.ms);
        break;
      default:
        break;
    }
  }

  /**
   * 單盤 diff → 發聲。只在「state 或 zone 改變」時動 audioEngine,避免每幀重觸發。
   * @param {{state:string, zone:number|null}} cur 本幀盤狀態
   * @param {{state:string, zone:number|null}} prev 上一幀盤狀態
   * @param {(slot:number|null)=>void} apply REST→null;ACTIVE(k)→該音/和弦
   */
  function diffApply(cur, prev, apply) {
    if (cur.state === prev.state && cur.zone === prev.zone) return;
    if (cur.state === 'ACTIVE' && cur.zone != null) {
      apply(cur.zone);
    } else {
      apply(null);
    }
  }

  /**
   * 停止手勢狀態機(每幀呼叫):雙手握拳持續 ≥ FIST_HOLD_MS → toggle 停止/繼續;
   * 放開雙拳後重新武裝(一次握拳手勢只切一次)。
   * @param {number} now performance.now() ms
   */
  function evaluatePauseGesture(now) {
    if (latestBothFists) {
      if (bothFistsSince === 0) bothFistsSince = now;
      if (pauseArmed && now - bothFistsSince >= FIST_HOLD_MS) {
        setPaused(!paused);
        pauseArmed = false; // 已切換;須放開雙拳才能再切
      }
    } else {
      bothFistsSince = 0;
      pauseArmed = true; // 放開 → 重新武裝
    }
  }

  /**
   * 進入 / 離開「停止演奏」。
   *  - 進入:立即靜音(和弦 + 旋律 release、伴奏律動暫停),並把 diff 基準歸 REST,
   *    使後續握拳期間不再觸發、且繼續後第一個指向能重新發聲。
   *  - 離開:把伴奏律動還原成使用者設定(grooveOn);和弦/旋律待手指下次指向自然重觸。
   * @param {boolean} v
   */
  function setPaused(v) {
    if (v === paused) return;
    paused = v;
    if (paused) {
      audioEngine.setMelodyNote(null);
      audioEngine.setChord(null);
      audioEngine.setGroove(false, bpm); // 暫停自動伴奏(grooveOn 仍保留使用者設定)
      prevL = { state: 'REST', zone: null };
      prevR = { state: 'REST', zone: null };
    } else {
      audioEngine.setGroove(grooveOn, bpm); // 還原使用者的伴奏設定
    }
  }

  /** rAF 主迴圈一幀(設計 §5)。 */
  function frame() {
    if (!looping) return;
    rafId = requestAnimationFrame(frame);

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // ── 執行期 FPS 量測(rAF 幀間隔 EMA)→ 動態調偵測頻率(設計 §8)──
    if (lastFrameTs) {
      const frameMs = now - lastFrameTs;
      if (frameMs > 0 && frameMs < 1000) fpsEmaMs = fpsEmaMs * 0.9 + frameMs * 0.1;
      const fps = 1000 / fpsEmaMs;
      // 低於 ~40fps → 隔 1 幀偵測(2);低於 ~25fps → 隔 2 幀(3);恢復則調回。
      const target = fps < 25 ? 3 : fps < 40 ? 2 : 1;
      if (target !== currentDetectEvery) {
        currentDetectEvery = target;
        if (typeof handTracker.setDetectEvery === 'function') handTracker.setDetectEvery(target);
      }
    }
    lastFrameTs = now;

    // 相機影像寬高比(對齊 video object-fit:cover;設計 §6 三者對齊)。
    const cameraAspect =
      video && video.videoWidth > 0 && video.videoHeight > 0
        ? video.videoWidth / video.videoHeight
        : undefined;
    const viewport = { width: DESIGN_VIEW.width, height: DESIGN_VIEW.height, cameraAspect };

    // 只有「新偵測幀」才推進 One-Euro 並用真實偵測 dt;否則重用上幀結果(僅重繪),
    // 避免對 stale 座標重跑濾波(dx=0 壓低 cutoff → 反而更拖;設計 §2.4 / §7)。
    let result = lastResult;
    if (detectSeq !== lastConsumedSeq) {
      const dt = lastDetectTs ? (now - lastDetectTs) / 1000 : undefined;
      result = mapper.update(latestTips, viewport, dt);
      lastConsumedSeq = detectSeq;
      lastDetectTs = now;
      lastResult = result;
    }
    if (!result) {
      // 尚無任何偵測幀:畫 idle 盤,等待第一筆偵測。
      result = mapper.update([], viewport, undefined);
      lastResult = result;
    }

    // 停止手勢(雙手握拳 toggle)。先評估,再決定本幀是否發聲。
    evaluatePauseGesture(now);

    if (!paused) {
      // diff → 發聲
      diffApply(result.L, prevL, (slot) => {
        audioEngine.setChord(slot == null ? null : musicEngine.chordForSlot(slot).midi);
      });
      diffApply(result.R, prevR, (slot) => {
        audioEngine.setMelodyNote(slot == null ? null : musicEngine.noteForSlot(slot).midi);
      });
      prevL = { state: result.L.state, zone: result.L.zone };
      prevR = { state: result.R.state, zone: result.R.zone };
    }
    // 停止中:不觸發、prev 維持 REST(進入時已歸零),繼續後第一個指向會重新發聲。

    // 視覺回饋(設計 §6)。氣泡 label 由 musicEngine 即時查名(已隨 key/scale)。
    // 停止中:仍畫游標(讓使用者看到手),但不顯示發聲高亮 / 氣泡。
    const present = !!(result.L.present || result.R.present);
    const lActive = !paused && result.L.state === 'ACTIVE' && result.L.zone != null;
    const rActive = !paused && result.R.state === 'ACTIVE' && result.R.zone != null;
    renderer.draw({
      present,
      paused,
      L: {
        zone: paused ? null : result.L.zone,
        active: lActive,
        tip: result.L.tip,
        label: lActive ? chordLabels[result.L.zone] : undefined,
        slotLabels: chordLabels,
      },
      R: {
        zone: paused ? null : result.R.zone,
        aim: result.R.aim,
        active: rActive,
        tip: result.R.tip,
        label: rActive ? melodyLabels[result.R.zone] : undefined,
        slotLabels: melodyLabels,
      },
    });

    // 提示狀態:停止中 → 明示;否則有手 live、無手 no-hand(設計 §8)。
    if (paused) ui.setStatus('live', '已停止演奏 — 雙手握拳繼續');
    else ui.setStatus(present ? 'live' : 'no-hand');
  }

  /**
   * 啟動:解鎖音訊 → 相機 → 手追蹤 → rAF 主迴圈。
   * 任一 I/O 失敗都以友善錯誤卡片呈現(設計 §8),不讓未捕捉例外冒泡。
   * @returns {Promise<void>}
   */
  async function start() {
    try {
      ui.hideOverlay();
      ui.setStatus('loading');

      // 1) 使用者手勢後解鎖 AudioContext(設計 §8)。
      await audioEngine.unlock();
      // 套用初始伴奏狀態。
      audioEngine.setGroove(grooveOn, bpm);
      ui.setGroove(grooveOn, bpm);

      // 2) 開相機(請求授權)。失敗 throw CameraError → 錯誤卡片。
      await camera.start();

      // 3) 啟動手部追蹤(載入模型;失敗 throw → 錯誤卡片)。
      await handTracker.start();

      // 4) 跑主迴圈。
      looping = true;
      mapper.reset();
      prevL = { state: 'REST', zone: null };
      prevR = { state: 'REST', zone: null };
      // 重置停止手勢狀態(避免重試帶舊狀態)。
      paused = false;
      latestBothFists = false;
      bothFistsSince = 0;
      pauseArmed = true;
      // 重置偵測/FPS 量測狀態,避免重試時帶舊時間戳。
      detectSeq = 0;
      lastConsumedSeq = -1;
      lastDetectTs = 0;
      lastResult = null;
      lastFrameTs = 0;
      fpsEmaMs = 1000 / 60;
      currentDetectEvery = 1;
      latestTips = [];
      rafId = requestAnimationFrame(frame);
      ui.setStatus('no-hand');
    } catch (err) {
      // 統一錯誤分流:相機/模型載入失敗皆呈現可重試卡片(設計 §8),不崩 app。
      stop();
      const message =
        err instanceof CameraError
          ? err.message
          : (err && err.message) || '發生未知錯誤,請重試。';
      ui.showError(message, () => {
        start();
      });
    }
  }

  /** 停止主迴圈與所有 I/O。 */
  function stop() {
    looping = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    handTracker.stop();
    camera.stop();
    audioEngine.setChord(null);
    audioEngine.setMelodyNote(null);
    latestTips = [];
    paused = false;
    latestBothFists = false;
    bothFistsSince = 0;
    pauseArmed = true;
  }

  return { start, stop, setHandFrame, applyChange };
}
