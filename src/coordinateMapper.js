/**
 * coordinateMapper.js — 純邏輯,無 DOM、無副作用(設計 §4.1)。
 *
 * 職責:把「兩手食指尖的 normalized 座標」映射成「左/右兩盤的觸發狀態」。
 * 內含:One-Euro 平滑(§2.3.1)、角度→塊(geometry)、中心死區(§2.3.3)、
 * 邊界遲滯 hysteresis(§2.3.2)、按「螢幕左右位置」分盤(§2.1)。
 *
 * 此模組可單元測試(設計 §9:座標序列 → 預期 zone/changed;hysteresis 不亂跳;死區進出)。
 *
 * 狀態機(設計 §2.2,左右盤共用底層、各自獨立):
 *   REST(死區內 / 未偵測到手) ──移出死區到第 k 塊──▶ ACTIVE(k)
 *   ACTIVE(k) ──移回死區 / 手消失──▶ REST
 *   ACTIVE(k) ──跨邊界到第 j 塊(超過 hysteresis margin)──▶ ACTIVE(j)
 *
 * 座標空間約定(重要):
 *  - update 的 disks 幾何與 viewport **必須同一像素空間**(本專案為 config.DESIGN_VIEW
 *    1280×720 設計空間;app.js 負責讓兩者一致,或同步縮放)。mapper 以 viewport 把
 *    normalized 0..1 換算成該像素空間。
 *  - 畫面為水平鏡像顯示(§2.1),但 tipsNormalized 是 MediaPipe 原始(未鏡像)。分盤前
 *    先把 x 反鏡像:screenX = (1 - rawX) * viewport.width,使「使用者左手」落在「畫面左半 → L」。
 */

import {
  angleOf,
  isInDeadzone,
  slotForAngle,
  angleMarginToBoundary,
  radiusOf,
  keyAtPoint,
} from './geometry.js';
import { ONE_EURO, HYSTERESIS_DEG, KEY_HYSTERESIS_PX, KEY_DWELL_DIFF_MS, KEY_DWELL_SAME_MS } from './config.js';

/**
 * One-Euro filter 名目取樣率(Hz),僅作為 update() 未帶實際 dt 時的後備值
 * (例如單元測試)。實機應由 app 量測真實 frame dt 傳入(設計 §2.4:延遲是命脈,
 * 掉幀時用真實 dt 才不會讓 One-Euro 過度平滑變拖)。
 */
const NOMINAL_FPS = 60;

/**
 * 把 normalized 0..1(相對相機影像、未鏡像)換算成設計空間像素,並對齊
 * <video> object-fit:cover 與 renderer 設計空間 cover 的雙重裁切(設計 §6:盤、游標、
 * 人影三者對齊)。
 *
 * 推導:normalized → (video cover 進視窗 CSS 像素) → (renderer 設計空間 cover 的反變換)。
 * 兩個 cover 的「鋪滿容器、置中裁切」效果在數學上可合成為:
 *   先把 normalized 對映到「相機影像在設計空間上等比 cover 後的可見矩形」。
 * 即:以 cameraAspect 對 DESIGN_VIEW 做 cover,得到影像鋪滿設計空間時的縮放與裁切偏移,
 * normalized 直接落在該影像矩形內 → 得設計空間座標。這與 video 在真實視窗的 cover 等價
 * (因 renderer 設計空間→視窗也是同一 cover,兩段相消)。
 *
 * @param {{x:number,y:number}} tn normalized 0..1(未鏡像)
 * @param {{width:number,height:number,cameraAspect?:number}} vp
 *   width/height = 設計空間尺寸;cameraAspect = 相機影像寬高比(videoWidth/videoHeight)。
 *   未提供 cameraAspect 時退回純線性映射(向後相容單元測試)。
 * @returns {{x:number,y:number}} 設計空間像素(已反鏡像:畫面左半→x 小)
 */
function normalizedToDesign(tn, vp) {
  const W = vp.width;
  const H = vp.height;
  // 反鏡像:畫面水平鏡像顯示,故畫面 x = (1 - rawX)(設計 §2.1)。
  const mx = 1 - tn.x;
  const my = tn.y;
  const camAR = vp.cameraAspect;
  if (!camAR || camAR <= 0) {
    // 後備:無相機比例資訊 → 純線性拉伸(舊行為)。
    return { x: mx * W, y: my * H };
  }
  const designAR = W / H;
  // 相機影像以 cover 鋪滿設計空間:取較大縮放,溢出維度被裁切。
  // 影像在設計空間中的可見尺寸與偏移:
  let imgW;
  let imgH;
  if (camAR > designAR) {
    // 影像較寬 → 高度填滿、左右裁切。
    imgH = H;
    imgW = H * camAR;
  } else {
    // 影像較高 → 寬度填滿、上下裁切。
    imgW = W;
    imgH = W / camAR;
  }
  const ox = (W - imgW) / 2;
  const oy = (H - imgH) / 2;
  return { x: ox + mx * imgW, y: oy + my * imgH };
}

/**
 * @typedef {Object} DiskGeom 盤幾何(設計空間像素,通常來自 config.DISKS)
 * @property {number} cx 圓心 x
 * @property {number} cy 圓心 y
 * @property {number} rIn 內徑(= 死區半徑)
 * @property {number} rOut 外徑
 * @property {number} slots 塊數
 */

/**
 * @typedef {Object} DiskState 單盤一幀的輸出
 * @property {'REST'|'ACTIVE'} state 狀態
 * @property {number|null} zone 命中塊 0..slots-1;REST 時為 null
 * @property {boolean} changed 相對上一幀「狀態或 zone」是否改變(供 diff/觸發)
 * @property {{x:number,y:number}|null} tip 平滑後該盤指尖座標(設計空間像素);無手為 null
 * @property {boolean} present 該盤是否有偵測到手
 * @property {number|null} [aim] 旋律琴鍵的瞄準鍵(僅 keyboard machine 輸出;圓盤為 undefined)
 */

/**
 * @typedef {Object} MapperResult 一幀的雙盤輸出
 * @property {DiskState} L 左盤(和弦)
 * @property {DiskState} R 右盤(旋律)
 */

// ───────────────────────── One-Euro filter(標準實作) ─────────────────────────

/** 計算 One-Euro 用的平滑係數 α。cutoff=截止頻率(Hz),dt=取樣間隔(s)。 */
function smoothingAlpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/**
 * 單一純量的 One-Euro filter(value + derivative 各一級低通,自適應截止)。
 * 對 x、y 各用一個實例。無時間戳,以固定 dt 餵入。
 * 參考:Casiez et al. "1€ Filter"。
 */
function createOneEuro({ minCutoff, beta, dCutoff }) {
  let xPrev = null; // 上一次輸出(平滑後)
  let dxPrev = 0; // 上一次導數(平滑後)
  let started = false;

  /** @param {number} x 原始值 @param {number} dt 取樣間隔(s) @returns {number} 平滑值 */
  function filter(x, dt) {
    if (!started) {
      // 首個樣本無歷史:直接採用,導數視為 0(避免冷啟動猛跳)。
      started = true;
      xPrev = x;
      dxPrev = 0;
      return x;
    }
    // 1) 估計導數並低通
    const dx = (x - xPrev) / dt;
    const aD = smoothingAlpha(dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * dxPrev;
    // 2) 依速度自適應截止頻率:動得快 → 截止高 → 更跟手
    const cutoff = minCutoff + beta * Math.abs(dxHat);
    const a = smoothingAlpha(cutoff, dt);
    const xHat = a * x + (1 - a) * xPrev;
    xPrev = xHat;
    dxPrev = dxHat;
    return xHat;
  }

  function reset() {
    xPrev = null;
    dxPrev = 0;
    started = false;
  }

  return { filter, reset };
}

// ───────────────────────── 單盤狀態機 ─────────────────────────

/**
 * 建立單盤的狀態 + 平滑記憶。封裝 One-Euro(x/y)、上一幀 state/zone。
 * @param {DiskGeom} disk 盤幾何(像素)
 */
function createDiskMachine(disk) {
  const fx = createOneEuro(ONE_EURO);
  const fy = createOneEuro(ONE_EURO);
  let state = 'REST'; // 'REST' | 'ACTIVE'
  let zone = null; // 0..slots-1 | null

  /**
   * 推進一幀。
   * @param {{x:number,y:number}|null} tipPx 本盤的指尖(像素,已分盤;null=無手)
   * @param {number} dt 取樣間隔(s)
   * @returns {DiskState}
   */
  function step(tipPx, dt) {
    const prevState = state;
    const prevZone = zone;

    if (!tipPx) {
      // 手消失 → REST,並清空平滑,避免下次出現時從舊點插值。
      fx.reset();
      fy.reset();
      state = 'REST';
      zone = null;
      const changed = prevState !== state || prevZone !== zone;
      return { state, zone, changed, tip: null, present: false };
    }

    // 平滑(設計空間像素)
    const sx = fx.filter(tipPx.x, dt);
    const sy = fy.filter(tipPx.y, dt);
    const tip = { x: sx, y: sy };

    if (isInDeadzone(tip, disk)) {
      // 回中心死區 → REST(設計 §2.2)。
      state = 'REST';
      zone = null;
    } else {
      const deg = angleOf(tip, disk);
      const rawZone = slotForAngle(deg, disk.slots);
      if (state === 'REST' || zone === null) {
        // 由 REST 出死區 → 直接進 rawZone(死區半徑本身即進入門檻,無須角度 hysteresis)。
        state = 'ACTIVE';
        zone = rawZone;
      } else if (rawZone === zone) {
        // 仍在同一塊內,維持。
        state = 'ACTIVE';
      } else {
        // 已 ACTIVE 但角度落入相鄰塊:須跨越「當前塊邊界」再多 HYSTERESIS_DEG 才換(設計 §2.3.2)。
        // angleMarginToBoundary 在已跨界時 = 越過該邊界的角度量。
        const overshoot = angleMarginToBoundary(deg, zone, disk.slots);
        if (overshoot > HYSTERESIS_DEG) {
          zone = rawZone; // 確實越過遲滯 → 換塊
        }
        // 否則黏在原塊(消除邊界顫動)。
        state = 'ACTIVE';
      }
    }

    const changed = prevState !== state || prevZone !== zone;
    return { state, zone, changed, tip, present: true };
  }

  function reset() {
    fx.reset();
    fy.reset();
    state = 'REST';
    zone = null;
  }

  return { step, reset };
}

// ───────────────────────── 右手旋律:琴鍵 in-shape 狀態機(2026-06-13) ─────────────────────────

/**
 * 建立右手旋律「單排彩虹琴鍵」狀態機(in-shape 機制,取代圓盤與演奏線)。
 * 輸出沿用 DiskState 形狀(state/zone/changed/tip/present)+ aim(= 目前所在鍵,供 renderer 高亮);
 * 故 app 觸發 diff 完全沿用:在鍵內 → ACTIVE(發 zone)、間隔/帶外 → REST(靜音)。
 *
 * 機制(設計 §2.2 melody / config.KEYBOARD):
 *  - 手指尖在某鍵「形狀內」(keyAtPoint)→ 發那個音;移到鍵間「間隔」或帶上下外 → 靜音。
 *  - 鍵間留 gap 間隔 = 相鄰音的靜音緩衝;要跳音(如 C→E)把手抬離鍵帶(上/下)= 靜音,移過去再放回 → 不刮中間音。
 *  - 邊界遲滯:已在某鍵時用擴張邊界(KEY_HYSTERESIS_PX)判斷是否仍在,消除鍵緣抖動進出。
 * @param {Object} kb config.KEYBOARD(x0/x1/keys/gap/keyTop/keyBottom…)
 */
function createKeyboardMachine(kb, dwell) {
  const fx = createOneEuro(ONE_EURO);
  const fy = createOneEuro(ONE_EURO);
  let zone = null; // 已確認發聲的 pad(已過 dwell);null = 靜音
  let candidate = null; // 目前所在 pad(待 dwell 確認)
  let dwellMs = 0; // 已在 candidate 累積停留時間(ms)
  let lastPlayed = null; // 上一個確認發聲過的 pad(跨靜音記憶;判斷「同音重觸」)
  let state = 'REST';

  /**
   * @param {{x:number,y:number}|null} tipPx 本手指尖(像素,已分盤;null=無手)
   * @param {number} dt 取樣間隔(s)
   * @returns {DiskState}
   */
  function step(tipPx, dt) {
    const prevState = state;
    const prevZone = zone;

    if (!tipPx) {
      fx.reset();
      fy.reset();
      zone = null;
      candidate = null;
      dwellMs = 0;
      state = 'REST';
      const changed = prevState !== state || prevZone !== zone;
      return { state, zone, aim: null, changed, tip: null, present: false };
    }

    const sx = fx.filter(tipPx.x, dt);
    const sy = fy.filter(tipPx.y, dt);
    const tip = { x: sx, y: sy };

    // 所在 pad:已在發聲 pad 時用擴張邊界(margin)黏住,避免邊緣抖動;否則用緊邊界重新偵測。
    let key;
    if (zone !== null && keyAtPoint(tip, kb, KEY_HYSTERESIS_PX) === zone) {
      key = zone;
    } else {
      key = keyAtPoint(tip, kb, 0);
    }

    if (key === null) {
      // 離開所有 pad → 立即靜音、清空待確認。
      candidate = null;
      dwellMs = 0;
      zone = null;
      state = 'REST';
    } else if (key === zone) {
      // 仍在發聲中的 pad → 維持(sustain)。
      candidate = key;
      state = 'ACTIVE';
    } else {
      // 進入「非當前發聲」的 pad → 須停留夠久才確認(過濾快速經過)。
      if (key === candidate) {
        dwellMs += dt * 1000;
      } else {
        candidate = key;
        dwellMs = 0;
      }
      // 同音重觸(candidate === 上次發聲音)用較短 dwell.sameMs;換到不同音用較長 dwell.diffMs。
      const threshold = candidate === lastPlayed ? dwell.sameMs : dwell.diffMs;
      if (dwellMs >= threshold) {
        zone = candidate; // 停留夠久 → 確認發聲
        lastPlayed = candidate;
        state = 'ACTIVE';
      } else {
        zone = null; // 尚未停留足夠(可能只是快速經過)→ 不發新音;舊音(若有)離開時已停
        state = 'REST';
      }
    }

    const changed = prevState !== state || prevZone !== zone;
    return { state, zone, aim: candidate, changed, tip, present: true };
  }

  function reset() {
    fx.reset();
    fy.reset();
    zone = null;
    candidate = null;
    dwellMs = 0;
    lastPlayed = null;
    state = 'REST';
  }

  return { step, reset };
}

// ───────────────────────── 工廠 ─────────────────────────

/**
 * 建立座標映射器。
 * @param {Object} opts
 * @param {{L:DiskGeom}} opts.disks 左盤(和弦圓盤)幾何(設計空間像素;見 config.DISKS)
 * @param {Object} opts.keyboard 右手旋律琴鍵幾何(見 config.KEYBOARD)
 * @returns {{
 *   update: (tipsNormalized: Array<{x:number,y:number}>, viewport: {width:number,height:number,cameraAspect?:number}, dt?: number) => MapperResult,
 *   reset: () => void
 * }} mapper
 *
 * @remarks
 *  - update 輸入 tipsNormalized:本幀偵測到的食指尖,normalized 0..1(MediaPipe 原始),
 *    可為 0、1 或 2 個點;**未經鏡像**(鏡像在分盤時處理:畫面左半→L、右半→R)。
 *  - viewport:盤幾何所在像素空間的尺寸(本專案 = DESIGN_VIEW);mapper 以此把 normalized 換算成像素。
 *  - 同一半若有多指,取最靠近該盤圓心者(設計 §2.1)。
 */
export function createMapper({ disks, keyboard }) {
  const machineL = createDiskMachine(disks.L);
  let kbGeom = keyboard; // 可在執行期換排列模式(thirds / row / pizza)
  const dwell = { diffMs: KEY_DWELL_DIFF_MS, sameMs: KEY_DWELL_SAME_MS }; // 兩段靈敏度(setDwell 可調)
  // pizza(kind:'disk')用和弦盤同款扇形 + 中心休息區機制;thirds/row(pads)用 in-shape + dwell。
  const buildMelodyMachine = (kb) =>
    kb.kind === 'disk' ? createDiskMachine(kb) : createKeyboardMachine(kb, dwell);
  let machineR = buildMelodyMachine(kbGeom);
  const fallbackDt = 1 / NOMINAL_FPS;

  // 中線分盤遲滯:記住每隻手「上一幀歸屬的盤」,避免手在畫面中央時於 L/R 間逐幀跳動
  // 切斷發聲(設計 §2.2:盤被搶走 → REST → 旋律斷音)。以「設計空間 x 與中線的帶狀
  // margin」做遲滯:已歸 L 的手要越過 中線+margin 才改判 R,反之亦然。
  // 注意:tips 無穩定 id,故以「最靠近哪一盤圓心」+ 中線帶狀遲滯近似(單手情境穩定;
  // 雙手交叉為設計已知取捨,§2.1)。
  let lastSide = null; // 'L' | 'R' | null(上一幀單手所在側;雙手時不適用,直接幾何分盤)
  const SIDE_HYSTERESIS_PX = (keyboard.cx - disks.L.cx) * 0.06;

  /**
   * 把 raw normalized 指尖分到左/右盤(依畫面鏡像後的螢幕位置;同半取最靠圓心者)。
   * @param {Array<{x:number,y:number}>} tipsNormalized
   * @param {{width:number,height:number}} viewport
   * @returns {{L: {x:number,y:number}|null, R: {x:number,y:number}|null}}
   */
  function assignTips(tipsNormalized, viewport) {
    const W = viewport.width;
    const half = W / 2;
    // 先把全部指尖換成設計空間像素(對齊 video cover;設計 §6)。
    const pts = [];
    for (const t of tipsNormalized || []) {
      if (!t || typeof t.x !== 'number' || typeof t.y !== 'number') continue;
      pts.push(normalizedToDesign(t, viewport));
    }

    if (pts.length === 0) {
      lastSide = null;
      return { L: null, R: null };
    }

    // 單手:中線帶狀遲滯,避免手在中央 L/R 跳動切斷發聲(設計 §2.2)。
    if (pts.length === 1) {
      const pt = pts[0];
      let side;
      if (lastSide === 'L') {
        side = pt.x > half + SIDE_HYSTERESIS_PX ? 'R' : 'L';
      } else if (lastSide === 'R') {
        side = pt.x < half - SIDE_HYSTERESIS_PX ? 'L' : 'R';
      } else {
        side = pt.x < half ? 'L' : 'R';
      }
      lastSide = side;
      return side === 'L' ? { L: pt, R: null } : { L: null, R: pt };
    }

    // 多手:依螢幕中線歸盤;左半取最靠圓心者(radiusOf),右半取最靠琴鍵區域中心 x 者
    // (keyboard 無圓心,用 x 距)。雙手交叉為設計已知取捨(§2.1)。
    lastSide = null;
    let bestL = null;
    let bestR = null;
    let bestLdist = Infinity;
    let bestRdist = Infinity;
    for (const pt of pts) {
      if (pt.x < half) {
        const dL = radiusOf(pt, disks.L);
        if (dL < bestLdist) { bestLdist = dL; bestL = pt; }
      } else {
        const dR = Math.abs(pt.x - kbGeom.cx);
        if (dR < bestRdist) { bestRdist = dR; bestR = pt; }
      }
    }
    return { L: bestL, R: bestR };
  }

  /**
   * @param {Array<{x:number,y:number}>} tipsNormalized
   * @param {{width:number,height:number}} viewport
   * @returns {MapperResult}
   */
  function update(tipsNormalized, viewport, dt) {
    const useDt = typeof dt === 'number' && dt > 0 ? dt : fallbackDt;
    const { L: tipL, R: tipR } = assignTips(tipsNormalized, viewport);
    return {
      L: machineL.step(tipL, useDt),
      R: machineR.step(tipR, useDt),
    };
  }

  /** 清空平滑與狀態記憶(例如重新開始 / 切換解析度時)。 */
  function reset() {
    machineL.reset();
    machineR.reset();
    lastSide = null;
  }

  /** 切換右手旋律排列模式(thirds / row):重建 keyboard 機制、沿用同一 dwell 設定。 */
  function setKeyboard(kb) {
    kbGeom = kb;
    machineR = buildMelodyMachine(kb);
  }

  /** 即時調整兩段靈敏度(dwell 毫秒);傳 undefined 的維持不動。 */
  function setDwell(diffMs, sameMs) {
    if (typeof diffMs === 'number') dwell.diffMs = diffMs;
    if (typeof sameMs === 'number') dwell.sameMs = sameMs;
  }

  return { update, reset, setKeyboard, setDwell };
}
