/**
 * renderer.js — Canvas 2D 繪製,疊在 video 上(設計 §4.1 / §6)。
 *
 * 職責:每幀畫雙盤(洋紅和弦盤 / 青綠旋律盤)、命中塊高亮 + glow、扇形標籤、
 * 中心休息區(虛線圈 + 字)、hub 標 CHORDS/MELODY、手游標(白色雙環 + 中心點 +
 * 從中心指出的虛線軌跡)、發聲氣泡(盤上方當前和弦/音名)。霓虹電音風格。
 *
 * 純繪製、不持有遊戲狀態(state 由 app 每幀傳入)。幾何用 geometry.js。
 *
 * 座標空間(對齊 mockup):盤幾何定義在 config.DESIGN_VIEW(1280×720)設計空間;
 * canvas 鋪滿容器,以 **cover(等比放大置中裁切)** 把設計空間映射到實際像素 ——
 * 與底層 video 的 `object-fit:cover` 及 mockup SVG 的 `preserveAspectRatio="xMidYMid slice"`
 * 完全一致,確保盤、游標、人影三者對齊。tip 已是設計空間像素(coordinateMapper 輸出),
 * 故 renderer 不再做鏡像 —— mapper 已把 MediaPipe 原始 x 反鏡像成「畫面上看到的位置」。
 */

import { polar, sectorPath, keyRect } from './geometry.js';
import { DESIGN_VIEW, COLORS } from './config.js';

/**
 * @typedef {Object} DiskRenderState 單盤繪製狀態
 * @property {number|null} zone 命中塊 0..slots-1;null=未命中
 * @property {boolean} active 是否 ACTIVE(發聲中)
 * @property {{x:number,y:number}|null} tip 游標座標(設計空間像素);null=無手
 * @property {string} [label] 發聲氣泡文字(當前和弦名 / 音名);ACTIVE 時才顯示
 * @property {string[]} [slotLabels] 各塊標籤(和弦名 / 唱名),長度 = slots
 */

/**
 * @typedef {Object} RenderState app 每幀傳入的繪製狀態(設計 §4.1 / §5)
 * @property {DiskRenderState} L 左盤(和弦)
 * @property {DiskRenderState} R 右盤(旋律)
 * @property {boolean} present 是否偵測到任何手(否 → idle 提示態)
 */

// ───────────────────────── 每盤靜態視覺常數(對齊 mockup wheel()) ─────────────────────────

/**
 * 每個 role 的 hue 漸層範圍(對齊 mockup:chord 330→275、melody 165→200)。
 * 塊 i 的色相 = hueA + (hueB-hueA)*(i/(n-1));highlight 與 idle 用同一 hue、不同明度/飽和。
 * disk.color 為該盤主色(發光錨點),title/休息區/氣泡用之。
 */
const ROLE_HUE = {
  chord: { a: 330, b: 275 },
  melody: { a: 165, b: 200 },
};

/** 標籤字體(沿用 styles.css 的 --font-ui;Canvas 需自帶 font 字串)。 */
const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Noto Sans TC", sans-serif';

/**
 * 建立 Canvas 渲染器。
 * @param {Object} opts
 * @param {HTMLCanvasElement} opts.canvas 疊在 video 上的 canvas
 * @param {{L:Object, R:Object}} opts.disks 雙盤幾何(設計空間像素;見 config.DISKS)
 * @returns {{
 *   draw: (state: RenderState) => void,  // 每幀呼叫(rAF 驅動)
 *   resize: () => void                   // viewport 改變時重設 canvas 像素尺寸(含 devicePixelRatio)
 * }} renderer
 *
 * @remarks
 *  - 幾何以設計空間(config.DESIGN_VIEW 1280×720)定義,draw 內把設計空間以 cover 變換映射到實際 canvas。
 *  - tip 座標單位 = 設計空間像素(與 coordinateMapper 輸出一致),draw 內用同一變換。
 *  - 效能:Path2D 扇形與標籤位置只在 prebuild()(建構 / resize)算一次;每幀僅做填色/描邊,
 *    不在 rAF 內重建大物件、不在 rAF 內配置陣列。
 */
export function createRenderer({ canvas, disks, keyboard }) {
  const ctx = canvas.getContext('2d');

  // cover 變換參數(設計空間 → 容器 CSS 像素);resize 時更新。
  // sx/sy 為縮放(cover 取較大者使其鋪滿),ox/oy 為置中偏移。
  const view = { scale: 1, ox: 0, oy: 0, cssW: 0, cssH: 0, dpr: 1 };

  // ── 手感 polish:時間驅動的動態回饋(不改 draw 介面;每幀內部讀時鐘)──
  // now:每幀更新一次,供脈動 / 入場動畫;draw 開頭設定。
  let nowMs = 0;
  /**
   * 每盤的瞬態動畫狀態(由 draw 依本幀 zone/active 推進):
   *  - lastZone:上一幀命中塊,用來偵測「換塊」→ 觸發 attack flash。
   *  - attackAt:最近一次新音 attack 的時間戳(ms);驅動 0→1→0 的閃光衰減。
   *  - bubbleZone / bubbleAt:氣泡當前承載的塊與其出現時間,驅動入場上浮 + 淡入。
   *  - lastActive:上一幀是否 active,用來偵測氣泡出現。
   */
  const anim = {
    L: { lastZone: null, attackAt: -1e9, bubbleZone: null, bubbleAt: -1e9, lastActive: false },
    R: { lastZone: null, attackAt: -1e9, bubbleZone: null, bubbleAt: -1e9, lastActive: false },
  };

  // 每盤預建的靜態幾何(扇形 Path2D、標籤錨點),建構 / resize 時算一次。
  // 結構:{ key, geom, hue:{a,b}, sectors:[{path, mid, labelPos}], restR }
  const diskCache = [];

  // 右手旋律琴鍵的預建幾何(buildKeyboard 結果);2026-06-13 取代圓盤。
  let keyboardCache = null;

  /**
   * 預建一盤的靜態幾何(在設計空間算,draw 時統一套 cover 變換 → 不必重算)。
   * @param {string} key 'L'|'R'
   * @param {Object} geom config.DISKS[key]
   */
  function buildDisk(key, geom) {
    const { cx, cy, rIn, rOut, slots, role } = geom;
    const step = 360 / slots;
    const hue = ROLE_HUE[role] || ROLE_HUE.chord;
    const sectors = new Array(slots);
    for (let i = 0; i < slots; i++) {
      const a0 = i * step;
      const a1 = a0 + step;
      const mid = a0 + step / 2;
      const labelPos = polar(cx, cy, (rIn + rOut) / 2, mid);
      // sectorPath 回傳 SVG "d";Path2D 可直接解析(設計空間座標)。
      const path = new Path2D(sectorPath(cx, cy, rIn, rOut, a0, a1));
      sectors[i] = { a0, a1, mid, path, labelPos };
    }
    return {
      key,
      geom,
      step,
      hue,
      sectors,
      // 休息區虛線圈半徑(對齊 mockup:rIn-8)。
      restR: rIn - 8,
    };
  }

  /**
   * 預建右手旋律琴鍵的靜態幾何(每鍵 rect + 標籤位置;設計空間)。2026-06-13。
   * @param {Object} kb config.KEYBOARD
   */
  function buildKeyboard(kb) {
    const { keys } = kb;
    const cells = new Array(keys);
    for (let i = 0; i < keys; i++) {
      const r = keyRect(i, kb); // 視覺鍵矩形(與 mapper 的 in-shape 判定同一形狀)
      cells[i] = {
        i,
        x: r.x,
        w: r.w,
        cx: r.x + r.w / 2,
        cy: r.y + r.h / 2,
        top: r.y,
        bottom: r.y + r.h,
        h: r.h,
        color: (kb.keyColors && kb.keyColors[i]) || kb.color, // 彩虹色 C..B
      };
    }
    return { kb, cells };
  }

  function prebuild() {
    diskCache.length = 0;
    diskCache.push(buildDisk('L', disks.L));
    keyboardCache = buildKeyboard(keyboard);
  }

  /**
   * 重算 canvas 像素尺寸與 cover 變換。容器尺寸由 canvas 的 CSS 佈局決定(.scene inset:0)。
   * 以 devicePixelRatio 提高清晰度;設計空間以 cover 對齊底層 video 的 object-fit:cover。
   */
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width || window.innerWidth;
    const cssH = rect.height || window.innerHeight;

    // backing store 尺寸 = CSS 尺寸 × dpr(避免模糊);CSS 尺寸交給佈局。
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    // cover:取較大縮放使設計空間鋪滿容器,溢出部分置中裁切。
    const scale = Math.max(cssW / DESIGN_VIEW.width, cssH / DESIGN_VIEW.height);
    view.scale = scale;
    view.ox = (cssW - DESIGN_VIEW.width * scale) / 2;
    view.oy = (cssH - DESIGN_VIEW.height * scale) / 2;
    view.cssW = cssW;
    view.cssH = cssH;
    view.dpr = dpr;
  }

  // ───────────────────────── 繪製輔助(皆在「設計空間座標」下作畫;由 ctx transform 統一映射) ─────────────────────────

  /** 設定設計空間 → backing store 的變換(dpr × cover)。draw 開頭呼叫一次。 */
  function applyTransform() {
    // 先重設,再套 dpr,再套 cover(平移 + 縮放)。順序:像素 = (設計座標*scale + offset) * dpr
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0); // CSS px → device px
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);
  }

  /**
   * 畫一盤(扇形 + 標籤 + 命中高亮 + 休息區 + 游標 + 氣泡)。
   * @param {Object} cache buildDisk 結果
   * @param {DiskRenderState} ds 該盤本幀狀態
   * @param {boolean} present 是否偵測到任何手(idle 時降低亮度)
   */
  function drawDisk(cache, ds, present, a) {
    const { geom, sectors, hue, step, restR } = cache;
    const { cx, cy, rIn, rOut, slots, color } = geom;
    const zone = ds && typeof ds.zone === 'number' ? ds.zone : null;
    const active = !!(ds && ds.active);
    const slotLabels = (ds && ds.slotLabels) || null;

    // ── 推進瞬態動畫狀態(換塊 → attack flash;氣泡出現 → 入場)──
    if (active && zone != null && (zone !== a.lastZone || !a.lastActive)) {
      a.attackAt = nowMs; // 新音 attack:觸發閃光
    }
    if (active && zone != null && (zone !== a.bubbleZone || !a.lastActive)) {
      a.bubbleZone = zone;
      a.bubbleAt = nowMs; // 氣泡換內容:重新入場
    }
    a.lastZone = zone;
    a.lastActive = active;

    // attack flash 強度(0..1,~220ms 衰減);active 高亮塊與氣泡共用。
    const flash = active ? Math.max(0, 1 - (nowMs - a.attackAt) / 220) : 0;
    // sustain 呼吸:active 期間極輕微的 glow 脈動,讓「持續發聲」有生命感。
    const breathe = active ? 0.5 + 0.5 * Math.sin(nowMs / 360) : 0;

    // 1) 扇形塊(非高亮先畫,維持 mockup 的色階)
    for (let i = 0; i < slots; i++) {
      if (i === zone) continue; // 高亮塊最後畫(疊在上層 + glow)
      const s = sectors[i];
      const h = hue.a + (hue.b - hue.a) * (slots > 1 ? i / (slots - 1) : 0);
      const light = i % 2 ? 30 : 38; // 交錯明度,塊界更清楚(mockup)
      ctx.beginPath();
      ctx.fillStyle = `hsl(${h}, 60%, ${light}%)`;
      ctx.globalAlpha = present ? 0.92 : 0.66; // idle 時整盤暗一階(設計 §8 idle 態)
      ctx.fill(s.path);
      ctx.globalAlpha = 1;
      // 細描邊(深色,分隔塊)
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(6, 9, 18, 0.7)';
      ctx.lineJoin = 'round';
      ctx.stroke(s.path);
      // 塊標籤
      if (slotLabels && slotLabels[i] != null) {
        drawSlotLabel(s.labelPos, slotLabels[i], false);
      }
    }

    // 2) 命中塊高亮(發光 + 白邊 + 亮填 + attack 閃光 + sustain 呼吸)
    if (zone != null) {
      const s = sectors[zone];
      const h = hue.a + (hue.b - hue.a) * (slots > 1 ? zone / (slots - 1) : 0);
      ctx.save();
      // glow:用該盤主色當光暈,模擬 mockup feGaussianBlur 疊圖。
      // active 時基準較亮、再疊 attack 閃光與 sustain 呼吸,讓發聲瞬間「打一下」、持續中微微起伏。
      ctx.shadowColor = color;
      ctx.shadowBlur = active ? 22 + breathe * 8 + flash * 22 : 14;
      // 命中亮度:active 飽和,attack 瞬間更白亮(往 100% 明度推),衰減後回穩。
      const light = active ? 62 + flash * 14 : 58;
      ctx.fillStyle = `hsl(${h}, 90%, ${light}%)`;
      ctx.globalAlpha = 1;
      ctx.fill(s.path);
      // 再填一次(無 shadow)讓塊體飽和、邊緣銳利
      ctx.shadowBlur = 0;
      ctx.fill(s.path);
      ctx.lineWidth = active ? 3 + flash * 1.5 : 3;
      ctx.strokeStyle = '#fff';
      ctx.lineJoin = 'round';
      ctx.stroke(s.path);
      ctx.restore();
      if (slotLabels && slotLabels[zone] != null) {
        drawSlotLabel(s.labelPos, slotLabels[zone], true);
      }
    }

    // 3) 中心休息區(虛線圈 + 標題 + 「休息區」)
    // 旋轉虛線(極慢)讓休息區「活著」;無手時整圈輕微呼吸,暗示「把手舉到這裡」。
    const restBreath = present ? 0 : 0.5 + 0.5 * Math.sin(nowMs / 600);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, restR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6, 9, 18, 0.55)';
    ctx.fill();
    ctx.setLineDash([5, 6]);
    ctx.lineDashOffset = -(nowMs / 90) % 11; // 緩慢順時針流動
    ctx.lineWidth = 1.5 + restBreath * 0.8;
    ctx.strokeStyle = color;
    ctx.globalAlpha = present ? 0.8 : 0.55 + restBreath * 0.35;
    // 無手時加一圈柔光,把目光引導回中心
    if (!present) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 6 + restBreath * 10;
    }
    ctx.stroke();
    ctx.restore();

    // hub 標題(CHORDS / MELODY)+ 休息區。手動字距(mockup letter-spacing:2)。
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color;
    ctx.font = `800 13px ${FONT_STACK}`;
    drawTracked(geom.hubLabel, cx, cy - 2, 2);
    ctx.fillStyle = COLORS.dim;
    ctx.font = `400 11px ${FONT_STACK}`;
    ctx.fillText('休息區', cx, cy + 16);
    ctx.restore();

    // 4) 手游標(白色雙環 + 中心點 + 從中心指出的虛線)— 僅該盤有手時
    if (ds && ds.tip) {
      drawCursor(cache, ds.tip, active);
    }

    // 5) 發聲氣泡(盤上方;ACTIVE 且有 label 時,帶入場上浮 + 淡入 + glow 脈動)
    if (active && ds && ds.label) {
      drawBubble(geom, color, ds.label, a, breathe);
    }
  }

  /**
   * 畫右手旋律「單排彩虹琴鍵」+ 游標 + 氣泡(2026-06-13 in-shape 版,無演奏線)。
   * 暗鍵 = 沒發聲但仍顯彩虹色(讓你看顏色瞄準);發音鍵(zone,in-shape)= 該色爆亮 + glow。
   * 游標在鍵內 = 染該鍵色發光、在間隔/帶外 = 白色空心(提示沒聲音)。
   * @param {Object} cache buildKeyboard 結果
   * @param {DiskRenderState & {aim?:number|null}} ds 該手本幀狀態
   * @param {boolean} present 是否偵測到任何手
   * @param {Object} a anim.R 瞬態動畫狀態
   */
  function drawKeyboard(cache, ds, present, a) {
    const { kb, cells } = cache;
    const { keys } = kb;
    const zone = ds && typeof ds.zone === 'number' ? ds.zone : null; // in-shape 發音鍵
    const active = !!(ds && ds.active);
    const slotLabels = (ds && ds.slotLabels) || null;
    const cx = (kb.x0 + kb.x1) / 2;

    // 瞬態動畫(換鍵 attack flash、氣泡入場、sustain 呼吸)
    if (active && zone != null && (zone !== a.lastZone || !a.lastActive)) a.attackAt = nowMs;
    if (active && zone != null && (zone !== a.bubbleZone || !a.lastActive)) {
      a.bubbleZone = zone;
      a.bubbleAt = nowMs;
    }
    a.lastZone = zone;
    a.lastActive = active;
    const flash = active ? Math.max(0, 1 - (nowMs - a.attackAt) / 220) : 0;
    const breathe = active ? 0.5 + 0.5 * Math.sin(nowMs / 360) : 0;

    // 彩虹鍵(暗鍵仍顯色以利瞄準;發音鍵該色爆亮 + glow)
    for (let i = 0; i < keys; i++) {
      const c = cells[i];
      const isOn = active && i === zone;
      ctx.save();
      if (isOn) {
        ctx.shadowColor = c.color;
        ctx.shadowBlur = 22 + breathe * 8 + flash * 24;
        ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = present ? 0.5 : 0.34; // idle:壓暗一階但保留彩虹色
      }
      ctx.fillStyle = c.color;
      roundRect(c.x, c.top, c.w, c.h, 9);
      ctx.fill();
      if (isOn) {
        ctx.shadowBlur = 0;
        ctx.fill();
      }
      ctx.restore();

      ctx.lineWidth = isOn ? 3 + flash * 1.5 : 1.5;
      ctx.strokeStyle = isOn ? '#fff' : 'rgba(255,255,255,0.18)';
      roundRect(c.x, c.top, c.w, c.h, 9);
      ctx.stroke();

      // 音名標籤(亮鍵深字、暗鍵白字)
      if (slotLabels && slotLabels[i] != null) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (isOn) {
          ctx.font = `800 22px ${FONT_STACK}`;
          ctx.fillStyle = '#06080f';
        } else {
          ctx.font = `700 18px ${FONT_STACK}`;
          ctx.fillStyle = 'rgba(255,255,255,0.92)';
        }
        ctx.fillText(slotLabels[i], c.cx, c.cy);
        ctx.restore();
      }
    }

    // 游標(在鍵內=染該鍵色發光;間隔/帶外=白色空心,提示沒聲音)
    if (ds && ds.tip) {
      drawKeyboardCursor(ds.tip, active, zone != null ? cells[zone].color : null);
    }

    // 發聲氣泡(發音鍵上方)
    if (active && ds && ds.label && zone != null) {
      drawBubbleAt(cells[zone].cx, kb.keyTop - 30, cells[zone].color, ds.label, a, breathe);
    }

    // idle 引導(無手時)
    if (!present) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = COLORS.dim;
      ctx.font = `600 13px ${FONT_STACK}`;
      ctx.fillText('手指到彩色音上就響,離開就停', cx, kb.keyBottom + 32);
      ctx.restore();
    }
  }

  /**
   * 旋律琴鍵游標:在鍵內(active+color)= 該鍵色實心發光 + 擴散光環;間隔/帶外 = 白色空心(沒聲音)。
   * @param {{x:number,y:number}} tip 設計空間像素
   * @param {boolean} active 是否在某鍵內(發聲中)
   * @param {string|null} color 該鍵色(不在鍵內為 null)
   */
  function drawKeyboardCursor(tip, active, color) {
    const on = active && !!color;
    ctx.save();
    if (on) {
      const t = (nowMs / 700) % 1; // 擴散光環
      const ringR = 24 + t * 20;
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, ringR, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.globalAlpha = (1 - t) * 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // 外環
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 22, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = on ? color : 'rgba(255,255,255,0.92)';
    if (on) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    // 內圈(在鍵內實心、否則半透明)
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 12, 0, Math.PI * 2);
    ctx.globalAlpha = on ? 0.9 : 1;
    ctx.fillStyle = on ? color : 'rgba(255,255,255,0.2)';
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    // 中心點
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = on ? '#06080f' : '#fff';
    ctx.fill();
    ctx.restore();
  }

  /**
   * 在指定中心畫發聲氣泡(膠囊 + glow + 深色字),帶入場上浮淡入。drawBubble 的通用版。
   * @param {number} cx 氣泡中心 x(設計空間)
   * @param {number} by0 氣泡中心 y 基準(設計空間)
   * @param {string} color 主色
   * @param {string} text 文字
   * @param {Object} a anim 狀態(取 bubbleAt)
   * @param {number} breathe sustain 呼吸量(0..1)
   */
  function drawBubbleAt(cx, by0, color, text, a, breathe) {
    const t = Math.min(1, (nowMs - a.bubbleAt) / 180);
    const ease = 1 - (1 - t) * (1 - t);
    const by = by0 + (1 - ease) * 10;
    const scale = 0.86 + ease * 0.14;
    const w = 120;
    const h = 42;
    const r = 21;
    ctx.save();
    ctx.globalAlpha = ease;
    ctx.translate(cx, by);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -by);
    ctx.shadowColor = color;
    ctx.shadowBlur = 16 + breathe * 8;
    ctx.fillStyle = color;
    roundRect(cx - w / 2, by - h / 2, w, h, r);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fill();
    ctx.fillStyle = '#06080f';
    ctx.font = `800 19px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, by);
    ctx.restore();
  }

  /**
   * 畫塊標籤(置中於塊中段半徑;高亮塊用深色大字、其餘白色)。
   * @param {{x:number,y:number}} pos 設計空間像素
   * @param {string} text
   * @param {boolean} hl 是否高亮塊
   */
  function drawSlotLabel(pos, text, hl) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (hl) {
      ctx.font = `800 23px ${FONT_STACK}`;
      ctx.fillStyle = '#0a0e1a';
    } else {
      ctx.font = `600 17px ${FONT_STACK}`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    }
    ctx.fillText(text, pos.x, pos.y);
    ctx.restore();
  }

  /**
   * 手游標:外環(r30 描邊)+ 內環(r16 半透明填 + 描邊)+ 中心點(r4),
   * 以及「從中心指出」的虛線(rIn-6 → 游標),暗示「指出去才響」。
   * @param {Object} cache buildDisk 結果
   * @param {{x:number,y:number}} tip 設計空間像素
   */
  function drawCursor(cache, tip, active) {
    const { geom } = cache;
    const { cx, cy, rIn, color } = geom;
    ctx.save();

    // 從中心指出的虛線:沿「圓心→游標」方向,自死區邊緣(rIn-6)畫到游標。
    const dx = tip.x - cx;
    const dy = tip.y - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    const sx = cx + ux * (rIn - 6);
    const sy = cy + uy * (rIn - 6);
    // 只有當游標在死區外才畫軌跡(在死區內畫了會反向、無意義)。
    // active 時用盤主色漸層、發光、虛線流動,強化「指出去 = 發聲」的因果回饋。
    if (dist > rIn - 6) {
      const dashFlow = -(nowMs / 60) % 8;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tip.x, tip.y);
      ctx.setLineDash([3, 5]);
      ctx.lineDashOffset = active ? dashFlow : 0;
      if (active) {
        const grad = ctx.createLinearGradient(sx, sy, tip.x, tip.y);
        grad.addColorStop(0, 'rgba(255,255,255,0.15)');
        grad.addColorStop(1, color);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
      } else {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 2;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
    }

    // active 時:外圈擴散的脈動光環(0→1 循環),像聲波從指尖擴出。
    if (active) {
      const t = (nowMs / 700) % 1; // 0..1 循環
      const ringR = 30 + t * 22;
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, ringR, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.globalAlpha = (1 - t) * 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 外環(active 時染上盤主色光暈,讓游標融入該盤色系)
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 30, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    if (active) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    // 內環(半透明填 + 細白描邊)
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 16, 0, Math.PI * 2);
    ctx.fillStyle = active ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 255, 255, 0.2)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    // 中心點
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();

    ctx.restore();
  }

  /**
   * 發聲氣泡:盤上方的圓角膠囊(主色 + glow)+ 深色字(當前和弦/音名)。
   * @param {Object} geom 盤幾何
   * @param {string} color 盤主色
   * @param {string} text 氣泡文字
   */
  function drawBubble(geom, color, text, a, breathe) {
    const { cx, cy, rOut } = geom;
    // 入場進度(0→1,~180ms ease-out):換和弦/音時氣泡微微上浮 + 放大 + 淡入。
    const t = Math.min(1, (nowMs - a.bubbleAt) / 180);
    const ease = 1 - (1 - t) * (1 - t);
    const rise = (1 - ease) * 10; // 由下往上落定
    const scale = 0.86 + ease * 0.14;
    const alpha = ease;
    const by = cy - rOut - 30 + rise; // 氣泡中心 y(mockup baseline + 入場上浮)
    const w = 132;
    const h = 44;
    const r = 22;

    ctx.save();
    ctx.globalAlpha = alpha;
    // 以氣泡中心為原點縮放,維持置中入場
    ctx.translate(cx, by);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -by);
    const x = cx - w / 2;
    const y = by - h / 2;

    ctx.shadowColor = color;
    ctx.shadowBlur = 16 + breathe * 8; // 持續發聲時 glow 隨呼吸起伏
    ctx.fillStyle = color;
    roundRect(x, y, w, h, r);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fill(); // 再填一次讓膠囊本體飽和
    // 文字
    ctx.fillStyle = '#06080f';
    ctx.font = `800 19px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, by);
    ctx.restore();
  }

  /**
   * 置中繪製帶字距(letter-spacing)的文字。Canvas 原生 letterSpacing 支援度不一,
   * 故逐字測寬手動排版,確保 CHORDS / MELODY 的霓虹字距在各瀏覽器一致。
   * @param {string} text
   * @param {number} cx 置中 x
   * @param {number} y 基線 y(使用呼叫端的 textBaseline)
   * @param {number} tracking 每字後的額外間距(設計空間像素)
   */
  function drawTracked(text, cx, y, tracking) {
    const chars = [...text];
    // 總寬 = 各字寬總和 + (字數-1)*tracking
    let total = 0;
    for (const ch of chars) total += ctx.measureText(ch).width;
    total += tracking * (chars.length - 1);
    const prevAlign = ctx.textAlign;
    ctx.textAlign = 'left';
    let x = cx - total / 2;
    for (const ch of chars) {
      ctx.fillText(ch, x, y);
      x += ctx.measureText(ch).width + tracking;
    }
    ctx.textAlign = prevAlign;
  }

  /** 在 ctx 當前路徑上描一個圓角矩形(相容無 roundRect 的環境)。 */
  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /**
   * @param {RenderState} state
   */
  function draw(state) {
    if (diskCache.length === 0) prebuild();
    if (view.cssW === 0) resize();

    // 動畫時鐘(脈動 / 入場 / 閃光皆讀此值)。
    nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // 清空整個 backing store(用 identity，確保完全清除不受 transform 影響)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 套設計空間變換,之後全部用設計座標作畫
    applyTransform();

    const present = !!(state && state.present);
    // 左盤(和弦圓盤)、右手(旋律琴鍵)
    drawDisk(diskCache[0], state ? state.L : null, present, anim.L);
    drawKeyboard(keyboardCache, state ? state.R : null, present, anim.R);
  }

  // 建構即預建幾何 + 量一次尺寸(若 canvas 已在 DOM)。
  prebuild();
  resize();

  return { draw, resize };
}
