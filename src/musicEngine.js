/**
 * musicEngine.js — 純邏輯,無 DOM、無副作用(設計 §4.1)。
 *
 * 職責:把「盤上的塊 index(slot)」映射成「和弦 / 旋律音」的 MIDI 與名稱。
 * 用 **scale degree → 音高** 的抽象(設計 §3.3):換 preset / key 只換對照表、
 * 不動其他模組。可單元測試(設計 §9:slot + key + scale → 預期 MIDI;transpose 正確)。
 *
 * 抽象核心:
 *  - 旋律音 = BASE_MIDI(主音 C4=60) + key 半音位移 + scale degree(八度循環) 。
 *    五聲只有 5 度但右盤 8 塊 → degree list 以八度 wrap(slot 5 = slot 0 + 12),
 *    在 key=C/pentatonic 下剛好還原 §3.1 的 [60,62,64,67,69,72,74,76]。
 *  - 和弦 = §3.2 C 大調 base 表的 MIDI + key 半音位移;和弦名隨根音 transpose,
 *    使「+7 後的 C 和弦」誠實顯示為 "G"(名與音高一致,不留 stale 標籤)。
 */
import {
  SLOTS,
  CHORDS_C,
  SCALE_PRESETS,
  KEY_OFFSETS,
  DEFAULT_KEY,
  DEFAULT_SCALE,
} from './config.js';

/**
 * 旋律主音 MIDI(key=C 的 scale degree 0)= C4。其餘音由此 + key + degree 推得。
 * 與 §3.1 的 C4=60 對齊。
 */
const BASE_MIDI = 60;

/** 升記號拼法的 12 音 pitch class(index = 半音,0=C)。和弦名 transpose 用。 */
const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** name → pitch class index 的反查(含 base 表用到的升記號拼法)。 */
const PITCH_CLASS_INDEX = Object.fromEntries(PITCH_CLASS_NAMES.map((n, i) => [n, i]));

/**
 * @typedef {Object} ChordResult
 * @property {string} name 和弦名(如 "Am")
 * @property {number[]} midi 和弦組成音 MIDI(voicing 由 audioEngine 收攏)
 */

/**
 * @typedef {Object} NoteResult
 * @property {string} name 音名(如 "G4")
 * @property {number} midi 單音 MIDI
 */

/**
 * 把和弦名拆成「根音 + 品質後綴」,例:"Am"→{root:'A', suffix:'m'},
 * "Fmaj7"→{root:'F', suffix:'maj7'},"C"→{root:'C', suffix:''}。
 * base 表只用升記號拼法,故根音最多 2 字(音名 + 可選 '#')。
 * @param {string} name
 * @returns {{root:string, suffix:string}}
 */
function splitChordName(name) {
  const root = name[1] === '#' ? name.slice(0, 2) : name[0];
  return { root, suffix: name.slice(root.length) };
}

/**
 * 把和弦名整體往上 transpose semitones 個半音(品質後綴不變)。
 * @param {string} name 原和弦名(C 大調 base)
 * @param {number} semitones 半音位移
 * @returns {string} transpose 後的和弦名
 */
function transposeChordName(name, semitones) {
  const { root, suffix } = splitChordName(name);
  const pc = (PITCH_CLASS_INDEX[root] + semitones) % 12;
  return PITCH_CLASS_NAMES[((pc % 12) + 12) % 12] + suffix;
}

/**
 * MIDI → 音名(含八度,科學音高記號),例:60→"C4"。旋律單音用。
 * @param {number} midi
 * @returns {string}
 */
function midiToName(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return PITCH_CLASS_NAMES[pc] + octave;
}

/**
 * 驗證 slot 在 [0, SLOTS) 且為整數;否則拋出明確錯誤。
 * 純函數的誠實契約:越界輸入 fail-fast,不回傳垃圾。
 * @param {number} k
 */
function assertSlot(k) {
  if (!Number.isInteger(k) || k < 0 || k >= SLOTS) {
    throw new RangeError(`musicEngine: slot ${k} 越界(需為 0..${SLOTS - 1} 的整數)`);
  }
}

/**
 * 建立樂理引擎。
 * @param {Object} [opts]
 * @param {string} [opts.key='C'] 調(見 config.KEY_OFFSETS)
 * @param {string} [opts.scale='pentatonic'] 音階 preset(見 config.SCALE_PRESETS)
 * @returns {{
 *   chordForSlot: (k:number) => ChordResult,
 *   noteForSlot:  (k:number) => NoteResult,
 *   setKey:   (key:string) => void,
 *   setScale: (scale:string) => void,
 *   getKey:   () => string,
 *   getScale: () => string
 * }} engine
 */
export function createMusicEngine({ key = DEFAULT_KEY, scale = DEFAULT_SCALE } = {}) {
  let currentKey = validateKey(key);
  let currentScale = validateScale(scale);

  /** @param {string} k @returns {string} */
  function validateKey(k) {
    if (!(k in KEY_OFFSETS)) {
      throw new RangeError(`musicEngine: 未知 key "${k}"(可用:${Object.keys(KEY_OFFSETS).join(', ')})`);
    }
    return k;
  }

  /** @param {string} s @returns {string} */
  function validateScale(s) {
    if (!(s in SCALE_PRESETS)) {
      throw new RangeError(`musicEngine: 未知 scale "${s}"(可用:${Object.keys(SCALE_PRESETS).join(', ')})`);
    }
    return s;
  }

  /**
   * 左盤:slot k 的和弦(0..SLOTS-1)。以 key 半音整體 transpose base 和弦表(§3.2)。
   * 名稱亦隨根音 transpose,確保名與音高一致。
   * @param {number} k slot index
   * @returns {ChordResult}
   */
  function chordForSlot(k) {
    assertSlot(k);
    const offset = KEY_OFFSETS[currentKey];
    const base = CHORDS_C[k];
    return {
      name: offset === 0 ? base.name : transposeChordName(base.name, offset),
      midi: base.midi.map((m) => m + offset), // map = 回傳新陣列,base 表不被 mutate
    };
  }

  /**
   * 右盤:slot k 的旋律單音(0..SLOTS-1)。以 scale degrees + key 推音高(§3.1 / §3.3)。
   * degree list 以八度循環:degree = degrees[k % len],八度 = floor(k / len)。
   * @param {number} k slot index
   * @returns {NoteResult}
   */
  function noteForSlot(k) {
    assertSlot(k);
    const degrees = SCALE_PRESETS[currentScale];
    const degree = degrees[k % degrees.length];
    const octaveBump = 12 * Math.floor(k / degrees.length);
    const midi = BASE_MIDI + KEY_OFFSETS[currentKey] + degree + octaveBump;
    return { name: midiToName(midi), midi };
  }

  /** 換調(半音整體位移;設計 §3.3)。 */
  function setKey(k) {
    currentKey = validateKey(k);
  }

  /** 換音階 preset(pentatonic / major / minor / blues;設計 §3.3)。 */
  function setScale(s) {
    currentScale = validateScale(s);
  }

  /** @returns {string} 目前調 */
  function getKey() {
    return currentKey;
  }

  /** @returns {string} 目前音階 preset */
  function getScale() {
    return currentScale;
  }

  return { chordForSlot, noteForSlot, setKey, setScale, getKey, getScale };
}
