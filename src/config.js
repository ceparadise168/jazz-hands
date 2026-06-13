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
 * 旋律琴鍵的「水平換鍵」遲滯(設計空間像素)。瞄準鍵要換成相鄰鍵,指尖須越過鍵邊界
 * 再多此距離才換,消除鍵邊界顫動。鍵寬約 (x1-x0)/keys ≈ 72px,取 14px。
 */
export const KEY_HYSTERESIS_PX = 14;

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
 * 右手旋律「隔空琴鍵 + 演奏線」幾何(設計空間 1280×720;2026-06-13 取代圓盤)。
 * 互動:手在「演奏線上方」水平移動 = 瞄準某鍵(不發聲);壓過線進入鍵 = 發該音;
 * 抬回線上 = 靜音。壓下瞬間鎖定當下瞄準鍵、線下水平移動不換音(徹底消除「經過誤觸」)。
 * 演奏線雙閾值遲滯(pressY/releaseY):壓過 pressY 才發、抬過 releaseY 才停,
 * 中間帶不切換 → 手停在線附近不會狂發。
 *  - x0/x1:鍵區水平範圍;keys:鍵數;keyTop/keyBottom:鍵的 y 範圍(設計空間像素)。
 *  - lineY:演奏線 y;pressY/releaseY:發聲/靜音雙閾值(y 向下為正)。
 *  - cx:區域中心,供「螢幕左右位置分盤」用(與左盤中線一致)。
 */
export const KEYBOARD = {
  cx: 936, // 區域中心(螢幕左右分盤用);整排須在螢幕中線 640 右側,否則最左鍵會被左手搶走
  x0: 656, // 最左鍵左緣 673 > 640(中線右側)
  x1: 1216, // 最右鍵右緣 ~1199;留邊防 16:10 螢幕 cover 裁切左右(安全區 ~[64,1216])
  keys: 7, // C D E F G A B 單排(與左盤和弦的 8 塊脫鉤)
  gap: 36, // 柱間「靜音空隙」;停聲靠橫向滑進空隙(不必上下抬手),也分隔相鄰音
  // 高柱設計(2026-06-13):手指在某柱上「任何高度」都算指到該音 →「指到就響」,垂直不必精準、不必抬手;
  // 停聲 = 橫向滑進柱間空隙。柱高大、垂直寬鬆,解決矮鍵太精準/太小的問題。鍵寬 ≈ (x1-x0)/7 - gap ≈ 44。
  keyTop: 260, // 音柱 上緣(垂直置中於 ~380)
  keyBottom: 500, // 下緣(高 240 高柱;垂直寬鬆 → 指到就響、免抬手)
  // 彩虹對應 C..B:紅 橙 黃 綠 藍 靛 紫(2026-06-13 真機回饋)
  keyColors: ['#ff5a5a', '#ff9f43', '#ffd93d', '#4cd964', '#4d8cff', '#7b6cff', '#c061ff'],
  color: COLORS.melody, // 主色(游標 / fallback)
  role: 'melody',
  hubLabel: 'MELODY',
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
