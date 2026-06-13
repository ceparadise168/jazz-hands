/**
 * config.js — HandSing 集中參數常數(設計 doc §2.2 / §2.3 / §3 / §6 的 SSOT 映射)。
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
 * 雙盤幾何。rIn 由 CENTER_DEADZONE_RATIO 導出(死區半徑 = donut 內徑),
 * 確保「視覺休息區」與「狀態機死區」完全一致。
 * 左盤(L)= 和弦(洋紅),右盤(R)= 旋律(青綠)。
 * cx/cy/rIn/rOut 皆為設計空間像素;slots 為塊數。
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
  R: {
    cx: 950,
    cy: 380,
    rOut: DISK_R_OUT,
    rIn: DISK_R_OUT * CENTER_DEADZONE_RATIO,
    slots: SLOTS,
    color: COLORS.melody,
    role: 'melody',
    hubLabel: 'MELODY',
  },
};

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
export const DEFAULT_SCALE = 'pentatonic';

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
