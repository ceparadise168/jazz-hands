/**
 * config.js — Maestro 集中參數常數(設計 doc §2.2 / §2.3 / §3 / §6 的 SSOT 映射)。
 *
 * 所有「可調手感 / 樂理 / 配色 / 幾何」常數集中於此,其他模組一律 import,
 * 不得各自硬寫魔術數字。改參數只改這一檔。
 *
 * 單位約定:
 *  - 角度一律「度(degrees)」,0° 指向正上方、順時針遞增(與 geometry.polar 對齊)。
 *  - normalized 座標 0..1(MediaPipe 輸出);像素座標見 DESIGN viewBox(1280×720 設計空間)。
 */

// ───────────────────────── 盤的塊數 ─────────────────────────
/** 每盤扇形塊數(左右皆 8)。設計 §3.1 / §3.2。 */
export const SLOTS = 8;

// ───────────────────────── 防誤觸三件套(設計 §2.3) ─────────────────────────
/**
 * 中心死區(休息區)半徑 = 盤外徑的比例,也就是 donut 內徑比。
 * 設計值 0.35(夠大才容易「回中心」)。
 */
export const CENTER_DEADZONE_RATIO = 0.35;

/**
 * 邊界遲滯角度(度)。從第 k 塊換到相鄰塊,指尖須越過邊界再多此角度才換,
 * 消除邊界顫動亂跳。設計建議 6–8°,取 7°。
 */
export const HYSTERESIS_DEG = 7;

/**
 * 旋律 pad 的 in-shape 邊界遲滯(設計空間像素)。已在某 pad 時,邊界外擴此距離才算「離開」,
 * 消除 pad 邊緣顫動進出。須 < pad 間空隙的一半,否則吃掉「靜音空白」、無處休息。取 8px。
 */
export const KEY_HYSTERESIS_PX = 8;

/**
 * 旋律 pad 的「停留確認」時間(毫秒):手指進入 pad 須停留 ≥ 此時間才發聲,過濾「快速經過」誤觸。
 * 分兩段(2026-06-14 使用者要求):
 *  - DIFF:換到「不同」音 → 較長,過濾掃過其他音。
 *  - SAME:重觸「同一」音(剛離開又回來)→ 較短,讓連打同音跟手。
 * 越大越不靈敏、發聲延遲越高;可由 UI 即時調整(見 DWELL_LEVELS)。
 */
export const KEY_DWELL_DIFF_MS = 150; // 預設「鈍」(= 滑桿 55%);換不同音較不靈敏、過濾掃過
export const KEY_DWELL_SAME_MS = 30;

/**
 * 靈敏度 UI 檔位:label → dwell 毫秒(越小越靈敏)。「換音 / 同音」兩個控制共用此檔位表。
 * 必須依 ms 由小到大排序:UI 的 0~100% 微調滑桿以本表首尾 ms 為範圍(0%=最靈敏、100%=最鈍),
 * 文字檔位則是滑桿上的快速跳點。
 */
export const DWELL_LEVELS = [
  { id: 'fast', label: '靈敏', ms: 30 },
  { id: 'mid', label: '中', ms: 80 },
  { id: 'slow', label: '鈍', ms: 150 },
  { id: 'slowest', label: '超鈍', ms: 250 },
];

/**
 * One-Euro filter 起始參數(對食指尖座標平滑;設計 §2.3)。
 *  - minCutoff:越小越平滑(靜止抖動小),越大越跟手。
 *  - beta:速度項權重,越大快速移動越不拖。
 *  - dCutoff:導數低通截止(One-Euro 標準預設 1.0)。
 * 實測可微調,先用設計建議值。
 */
export const ONE_EURO = {
  minCutoff: 1.2,
  beta: 0.02,
  dCutoff: 1.0,
};

// ───────────────────────── 節奏 / 伴奏(設計 §3.4) ─────────────────────────
/** 自動伴奏律動預設 BPM。 */
export const BPM = 92;

/** 自動伴奏律動是否預設開啟(設計:預設關)。 */
export const GROOVE_DEFAULT_ON = false;

// ───────────────────────── 配色(設計 §6;與 styles.css 變數同步) ─────────────────────────
export const COLORS = {
  bg: '#06080f',      // 背景
  chord: '#ff5fa2',   // 洋紅:左盤和弦
  melody: '#27e0c8',  // 青綠:右盤旋律
  accent: '#ffc24b',  // 琥珀:強調
  ink: '#eef2ff',     // 主文字
  dim: '#9aa6c7',     // 次文字
};

// ───────────────────────── 雙盤幾何(設計空間 1280×720;設計 §6 / mockup) ─────────────────────────
/**
 * DESIGN_VIEW:盤幾何定義所在的設計座標空間。renderer / coordinateMapper
 * 會把實際 viewport 換算到此空間(或反向),確保比例一致。
 */
export const DESIGN_VIEW = { width: 1280, height: 720 };

/** 盤外徑(設計空間像素;mockup rOut=210)。 */
const DISK_R_OUT = 210;

/**
 * 左盤幾何(和弦圓盤)。rIn 由 CENTER_DEADZONE_RATIO 導出(死區半徑 = donut 內徑),
 * 確保「視覺休息區」與「狀態機死區」完全一致。cx/cy/rIn/rOut 為設計空間像素;slots 為塊數。
 * 右手旋律不再用圓盤(改用 KEYBOARD;2026-06-13:圓盤對旋律跳音不友善 —— 沿外圈滑會刮過中間音)。
 */
export const DISKS = {
  L: {
    cx: 330,
    cy: 380,
    rOut: DISK_R_OUT,
    rIn: DISK_R_OUT * CENTER_DEADZONE_RATIO, // = 73.5
    slots: SLOTS,
    color: COLORS.chord,
    role: 'chord',
    hubLabel: 'CHORDS',
  },
};

/**
 * 右手旋律幾何(設計空間 1280×720)。in-shape:手指在某 pad 形狀內 → 發該音;pad 之間/之外 → 靜音。
 * 兩種可切換排列(2026-06-14 使用者要求,UI 可切):
 *  - thirds(2D 三度排列,預設):上排 C E G B、下排錯半格 D F A → 相鄰/三度移動不經過其他鍵;方塊大。
 *  - row(單排鍵盤排列):C..B 由左到右一排;直覺,但相鄰移動會經過中間音。
 * 各 mode 提供 layout(每音 row/col)+ 幾何(originX/colStep/rowOffsetX/topY/rowStep/padW/padH)。
 * 共用:cx(分盤中心,須在中線 640 右側)、keys、keyColors(C..B 彩虹)、色/角色/標籤。
 */
export const KEYBOARD = {
  cx: 920, // 區域中心(分盤用;兩種排列都在中線 640 右側)
  keys: 7, // C D E F G A B(index 0..6)
  keyColors: ['#ff5a5a', '#ff9f43', '#ffd93d', '#4cd964', '#4d8cff', '#7b6cff', '#c061ff'], // 紅橙黃綠藍靛紫
  color: COLORS.melody,
  role: 'melody',
  hubLabel: 'MELODY',
  defaultMode: 'row', // 預設「鍵盤」單排;三度 / 披薩 可由 UI 切換
  modes: {
    // 2D 三度排列:上排 C E G B(0,2,4,6)、下排錯半格 D F A(1,3,5)
    thirds: {
      kind: 'pads', // in-shape pad 群(keyboard machine + dwell)
      layout: [
        { row: 0, col: 0 }, // C
        { row: 1, col: 0 }, // D
        { row: 0, col: 1 }, // E
        { row: 1, col: 1 }, // F
        { row: 0, col: 2 }, // G
        { row: 1, col: 2 }, // A
        { row: 0, col: 3 }, // B
      ],
      originX: 660,
      colStep: 145, // pad 96 + 空隙 49
      rowOffsetX: 72, // 半欄錯位 brick
      topY: 250,
      rowStep: 150, // pad 96 + 垂直空隙 54
      padW: 96,
      padH: 96,
    },
    // 單排鍵盤排列:C..B 由左到右(全 row 0)
    row: {
      kind: 'pads',
      layout: [
        { row: 0, col: 0 }, // C
        { row: 0, col: 1 }, // D
        { row: 0, col: 2 }, // E
        { row: 0, col: 3 }, // F
        { row: 0, col: 4 }, // G
        { row: 0, col: 5 }, // A
        { row: 0, col: 6 }, // B
      ],
      originX: 656,
      colStep: 80, // pad 56 + 空隙 24
      rowOffsetX: 0,
      topY: 300,
      rowStep: 0,
      padW: 56,
      padH: 150, // 直立鍵
    },
    // 披薩圓盤:跟和弦盤一樣的扇形 + 中心休息區(用 createDiskMachine,而非 pad in-shape)
    pizza: {
      kind: 'disk',
      cx: 950, // 右側圓盤中心(cx > 640 中線右側;rOut 210 → 邊緣 740..1160 在 16:10 安全區內)
      cy: 380,
      rOut: 210,
      rIn: 73.5, // = rOut × 0.35(與和弦盤同死區比例)
      slots: 7, // C D E F G A B
    },
  },
};

/**
 * 取得某排列模式的「完整生效幾何」(共用欄位 + 該 mode 的 layout/幾何);供 mapper/renderer 使用。
 * @param {'thirds'|'row'} mode
 */
export function melodyGeom(mode) {
  const m = KEYBOARD.modes[mode] || KEYBOARD.modes[KEYBOARD.defaultMode];
  return { ...KEYBOARD, ...m };
}

// ───────────────────────── 樂理映射(設計 §3) ─────────────────────────
/**
 * 右盤五聲音階(預設 C 大調 Major Pentatonic),由起始塊順時針音高遞增,
 * 跨約 1.6 八度。MIDI 對照(設計 §3.1)。
 * 此為 key=C / scale=pentatonic 的 base degrees;換 key 以半音 transpose。
 */
export const PENTATONIC_C_MIDI = [60, 62, 64, 67, 69, 72, 74, 76];

/** 唱名標籤(對應上面 8 塊;設計 mockup)。 */
export const PENTATONIC_C_LABELS = ['Do', 'Re', 'Mi', 'Sol', 'La', 'Do', 'Re', 'Mi'];

/**
 * 左盤和弦(C 大調 8 塊;設計 §3.2)。
 * midi 為 voicing 前的原始音;audioEngine 可收攏到中央八度。
 */
export const CHORDS_C = [
  { name: 'C', midi: [60, 64, 67] },
  { name: 'G', midi: [55, 59, 62] },
  { name: 'Am', midi: [57, 60, 64] },
  { name: 'Em', midi: [52, 55, 59] },
  { name: 'F', midi: [53, 57, 60] },
  { name: 'Dm', midi: [50, 53, 57] },
  { name: 'G7', midi: [55, 59, 62, 65] },
  { name: 'Fmaj7', midi: [53, 57, 60, 64] },
];

/**
 * Scale presets(設計 §3.3;stretch 但資料結構先預留)。
 * 值為「相對主音的半音 scale degree」,musicEngine 以此 + key transpose 出音高。
 * pentatonic 對齊 PENTATONIC_C_MIDI 的相對音程([0,2,4,7,9] 跨八度循環)。
 */
export const SCALE_PRESETS = {
  pentatonic: [0, 2, 4, 7, 9],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  blues: [0, 3, 5, 6, 7, 10],
};

/** 調 → 相對 C 的半音位移(設計 §3.3)。 */
export const KEY_OFFSETS = {
  C: 0,
  G: 7,
  D: 2,
  F: 5,
  A: 9,
};

/** 預設調與音階 preset。 */
export const DEFAULT_KEY = 'C';
// 預設用大調全音階(C D E F G A B + 高八度 C),讓右盤能彈出需要 Fa/Ti 的完整旋律。
// 五聲(pentatonic)仍保留為可切換 preset(更保險、亂指更不易撞音)。
export const DEFAULT_SCALE = 'major';

// ───────────────────────── 偵測 / 效能(設計 §2.4 / §8) ─────────────────────────
/**
 * 每隔幾幀做一次手部偵測(FPS 過低時調高;設計 §8)。1 = 每幀都偵測。
 */
export const DETECT_EVERY_N_FRAMES = 1;

/**
 * MediaPipe Hands 偵測設定(取 index fingertip = landmark 8)。
 * modelComplexity:0(lite)— 我們只需食指尖單點、不需精細骨架,lite 模型在筆電上
 * 明顯較快、較不易掉幀,跟手延遲更穩(設計 §2.4 延遲是命脈)。
 */
export const HAND_TRACKER = {
  maxNumHands: 2,
  modelComplexity: 0,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6,
  /** MediaPipe Hands 中食指尖的 landmark index。 */
  indexTipLandmark: 8,
};

/**
 * 停止手勢(指揮家「雙手握拳」)需持續握拳多久(ms)才切換 停止/繼續。
 * 加「短暫停留」門檻避免演奏中偶然握拳誤觸;放開後重新武裝,一次手勢 = 切一次(toggle)。
 */
export const FIST_HOLD_MS = 280;
