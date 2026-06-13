/**
 * audioEngine.js — 音訊 I/O 邊界,依賴 Tone.js(設計 §4.1 / §2.2 / §3.4 / §8)。
 *
 * 職責:把 musicEngine 算出的 MIDI 變成聲音。和弦 pad(左盤,sustain 鋪底)+
 * 旋律 lead(右盤,attack/sustain/release)+ 自動伴奏律動(Tone.Transport)。
 * envelope 平滑 attack/release + 換音短 crossfade,避免爆音(設計 §8)。
 *
 * 設計取捨:
 *  - 維持設計 §4.1 介面契約:unlock / setChord / setMelodyNote / setGroove /
 *    setInstrument(+ dispose 為清理用,非契約核心)。
 *  - 和弦 voicing 收攏到中央八度(C4 附近),避免低音渾濁;voicing 在本模組做,
 *    musicEngine 只給原始組成音(設計 §3.2 表頭註)。
 *  - groove 開啟時,Transport 依「目前和弦」做八分音符分解 / 刷弦 pattern;
 *    setChord 會更新「目前和弦」,Loop callback 即時取用,因此換和弦時 groove
 *    會自動跟著新和弦走(設計 §2.2 左盤 / §3.4)。
 *  - groove 開啟時和弦改走「節奏觸發」;groove 關閉時走乾淨長音 sustain。
 */

import * as Tone from 'tone';
import { BPM } from './config.js';

/**
 * 和弦 voicing 的根音錨點區下界(MIDI)。voiceChord 採「根音定錨」策略:
 * 把根音(midi[0])折到 [ROOT_ANCHOR_LO, ROOT_ANCHOR_LO+12) 的低參考八度當地基,
 * 其餘和弦音各自疊到根音之上最近位置 → 每個和弦最低音都是根音,聽感穩、不漂浮。
 * 48 = C3,使根音落在 C3~B3,明顯低於旋律(C4~E5),拉開音域層次。
 */
const ROOT_ANCHOR_LO = 48;

/** 換音 / 換和弦的短 crossfade / release 秒數,避免爆音(設計 §8)。 */
const CROSSFADE_S = 0.04;

/** MIDI → 頻率(Hz)。等溫律,A4(MIDI 69)=440Hz。 */
function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * 根音定錨 voicing(root-position,root-on-bottom):
 *  1) 把根音(midi[0])折到低參考八度 [ROOT_ANCHOR_LO, ROOT_ANCHOR_LO+12) 當地基。
 *  2) 其餘和弦音各自折到「根音之上」最近的位置(pitch class 對齊後補滿到 >= 根音)。
 * 結果每個和弦最低音都是根音 → 有低音支撐、不漂浮、辨識度高(設計 §3.2 收攏到中央八度,
 * 但保留根音定位)。
 * @param {number[]} midi 原始組成音(midi[0] 為根音)
 * @returns {number[]}
 */
function voiceChord(midi) {
  if (!midi || midi.length === 0) return [];
  // 1) 根音折進低參考八度。
  let root = midi[0];
  while (root < ROOT_ANCHOR_LO) root += 12;
  while (root >= ROOT_ANCHOR_LO + 12) root -= 12;
  // 2) 其餘音疊到根音之上最近位置。
  const voiced = [root];
  for (let i = 1; i < midi.length; i++) {
    let v = midi[i];
    while (v < root) v += 12;
    while (v - root >= 12) v -= 12; // 收到根音之上一個八度內,close voicing
    voiced.push(v);
  }
  return voiced;
}

/**
 * 建立音訊引擎。
 * @returns {{
 *   unlock: () => Promise<void>,
 *   setChord: (midi: number[] | null) => void,
 *   setMelodyNote: (midi: number | null) => void,
 *   setGroove: (on: boolean, bpm: number) => void,
 *   setInstrument: (chordInst: string, melodyInst: string) => void,
 *   dispose: () => void
 * }} audioEngine
 *
 * @remarks
 *  - unlock:必須在使用者手勢(點「開始」)後呼叫,啟動 AudioContext(設計 §8)。
 *  - setChord(midi[]):左盤進塊 → attack 鋪底;傳 null → release 停。
 *      換和弦時 release 舊 + attack 新、短 crossfade(設計 §2.2 左盤行為)。
 *  - setMelodyNote(midi):右盤進塊 → attack+sustain 單音;傳 null → release(靜音)。
 *  - setGroove(on,bpm):on→Tone.Transport 啟動,依當前和弦反覆分解 / 刷弦;
 *      off→停 Transport、和弦改乾淨長音(設計 §3.4 / §2.2)。
 *  - setInstrument:切換和弦 / 旋律音色。
 */
export function createAudioEngine() {
  // ── 內部狀態 ──
  /** 是否已建立 Tone 節點(unlock 後為 true)。 */
  let ready = false;
  /** 目前左盤和弦(已 voicing 的 MIDI),供 groove pattern 取用;null=無。 */
  let currentChord = null;
  /** 目前是否開啟 groove。 */
  let grooveOn = false;
  /** 目前旋律單音 MIDI(供 crossfade 換音),null=靜音。 */
  let currentMelody = null;

  // ── Tone 節點(unlock 時建立) ──
  /** @type {Tone.PolySynth} 和弦 pad(溫暖)。 */
  let chordSynth = null;
  /** @type {Tone.Synth} 旋律 lead(清亮)。 */
  let melodySynth = null;
  /** 各效果鏈節點,dispose 用。 */
  let chordChain = [];
  let melodyChain = [];
  /** @type {Tone.Loop} groove 八分音符迴圈。 */
  let grooveLoop = null;
  /** groove 內部步進索引(分解和弦用)。 */
  let grooveStep = 0;

  /**
   * 建立和弦 pad(溫暖)+ 旋律 lead(清亮)+ 效果鏈。
   * 溫暖 pad:triangle、慢 attack、長 release、過 lowpass + reverb。
   * 清亮 lead:快 attack、適中 release、共用 reverb 提空間感。
   */
  function buildNodes() {
    // 共用 reverb(空間感,避免聲音太乾)。放兩條鏈尾端、統一 dispose。
    const reverb = new Tone.Reverb({ decay: 2.4, wet: 0.28 }).toDestination();

    // 和弦 pad:PolySynth 包 triangle,溫暖、慢起音、長尾,過 lowpass 柔化高頻。
    const chordLP = new Tone.Filter({ type: 'lowpass', frequency: 2600, Q: 0.4 }).connect(reverb);
    const chordVol = new Tone.Volume(-9).connect(chordLP);
    chordSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.18, decay: 0.25, sustain: 0.75, release: 1.2 },
    }).connect(chordVol);
    chordSynth.maxPolyphony = 8;

    // 旋律 lead:單音 Synth,清亮、快起音、適中尾。
    const leadVol = new Tone.Volume(-6).connect(reverb);
    melodySynth = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.012, decay: 0.12, sustain: 0.7, release: 0.35 },
    }).connect(leadVol);

    chordChain = [chordSynth, chordVol, chordLP];
    melodyChain = [melodySynth, leadVol, reverb];

    Tone.getTransport().bpm.value = BPM;
  }

  /**
   * 觸發目前和弦一次(供 groove pattern 取用)。groove 開啟時被 Loop 反覆呼叫,
   * 以分解和弦 / 刷弦的方式做出八分音符律動感。即時讀 currentChord,
   * 因此換和弦會自動跟上(設計 §2.2 / §3.4)。
   * @param {number} time Tone 排程時間
   */
  function strumCurrentChord(time) {
    if (!chordSynth || !currentChord || currentChord.length === 0) return;
    const freqs = currentChord.map(midiToFreq);
    // 偶數拍:由低到高分解(微錯位模擬刷弦);奇數拍:取高音點綴。
    const downbeat = grooveStep % 2 === 0;
    if (downbeat) {
      freqs.forEach((f, i) => {
        chordSynth.triggerAttackRelease(f, '8n', time + i * 0.018, 0.6);
      });
    } else {
      const f = freqs[freqs.length - 1];
      chordSynth.triggerAttackRelease(f, '16n', time, 0.45);
    }
    grooveStep = (grooveStep + 1) % 8;
  }

  /** 依 grooveOn 重新套用目前和弦的發聲方式(長音 vs 律動)。 */
  function applyChordSounding() {
    if (!chordSynth) return;
    if (grooveOn) {
      // 律動模式:長音交給 Loop,先收持續長音避免疊音。
      chordSynth.releaseAll();
    } else {
      // 乾淨長音:把目前和弦整把按住 sustain。
      chordSynth.releaseAll();
      if (currentChord && currentChord.length) {
        chordSynth.triggerAttack(currentChord.map(midiToFreq));
      }
    }
  }

  /**
   * 使用者手勢後解鎖 AudioContext 並建立節點(設計 §8)。
   * @returns {Promise<void>}
   */
  async function unlock() {
    if (ready) return;
    await Tone.start();
    buildNodes();
    // reverb 需時間生成 impulse;等它 ready 再放行,避免首聲破音。
    const reverb = melodyChain[melodyChain.length - 1];
    if (reverb && typeof reverb.ready?.then === 'function') {
      await reverb.ready;
    }
    ready = true;
  }

  /**
   * @param {number[]|null} midi 和弦組成音(原始,未 voicing);null=停
   */
  function setChord(midi) {
    if (!ready) return;
    if (!midi || midi.length === 0) {
      currentChord = null;
      grooveStep = 0;
      chordSynth.releaseAll(); // release 舊和弦(envelope 尾,避免爆音)
      return;
    }
    const voiced = voiceChord(midi);
    currentChord = voiced;
    grooveStep = 0;
    if (!grooveOn) {
      // 換和弦:release 舊 + 短 crossfade attack 新(設計 §2.2)。
      chordSynth.releaseAll();
      chordSynth.triggerAttack(voiced.map(midiToFreq), `+${CROSSFADE_S}`);
    }
    // groove 開啟時不在此 attack;由 Loop 依 currentChord 反覆觸發。
  }

  /**
   * @param {number|null} midi 旋律單音;null=release
   */
  function setMelodyNote(midi) {
    if (!ready) return;
    if (midi == null) {
      if (currentMelody != null) {
        melodySynth.triggerRelease();
        currentMelody = null;
      }
      return;
    }
    const freq = midiToFreq(midi);
    if (currentMelody == null) {
      melodySynth.triggerAttack(freq);
    } else {
      // 換音:release 舊 + 短 crossfade attack 新,避免爆音(設計 §8)。
      melodySynth.triggerRelease();
      melodySynth.triggerAttack(freq, `+${CROSSFADE_S}`);
    }
    currentMelody = midi;
  }

  /**
   * @param {boolean} on 是否開啟自動伴奏律動
   * @param {number} bpm 速度
   */
  function setGroove(on, bpm) {
    if (!ready) return;
    const transport = Tone.getTransport();
    if (typeof bpm === 'number' && bpm > 0) transport.bpm.value = bpm;

    if (on === grooveOn) return; // 只是改 bpm

    grooveOn = on;
    if (on) {
      grooveStep = 0;
      if (!grooveLoop) {
        grooveLoop = new Tone.Loop((time) => strumCurrentChord(time), '8n');
      }
      grooveLoop.start(0);
      transport.start();
      applyChordSounding(); // 收掉乾淨長音,改由 Loop 觸發
    } else {
      if (grooveLoop) grooveLoop.stop();
      transport.stop();
      applyChordSounding(); // 回乾淨長音:若仍在某和弦塊,重新按住
    }
  }

  /**
   * 切換和弦 / 旋律音色,以 oscillator 類型 / 包絡概略表現不同質感。
   * @param {string} chordInst 'epiano' | 'synth' | 'pluck'
   * @param {string} melodyInst
   */
  function setInstrument(chordInst, melodyInst) {
    if (!ready) return;
    const chordOsc = { epiano: 'triangle', synth: 'fatsawtooth', pluck: 'triangle' }[chordInst] || 'triangle';
    const melodyOsc = { epiano: 'triangle', synth: 'sawtooth', pluck: 'triangle' }[melodyInst] || 'triangle';
    chordSynth.set({ oscillator: { type: chordOsc } });
    melodySynth.set({ oscillator: { type: melodyOsc } });
    if (melodyInst === 'pluck') {
      melodySynth.set({ envelope: { attack: 0.005, decay: 0.18, sustain: 0.25, release: 0.2 } });
    } else {
      melodySynth.set({ envelope: { attack: 0.012, decay: 0.12, sustain: 0.7, release: 0.35 } });
    }
  }

  /** 釋放所有 Tone 節點(清理)。 */
  function dispose() {
    if (grooveLoop) { grooveLoop.stop(); grooveLoop.dispose(); grooveLoop = null; }
    const transport = Tone.getTransport();
    transport.stop();
    [...chordChain, ...melodyChain].forEach((n) => n?.dispose?.());
    chordChain = [];
    melodyChain = [];
    chordSynth = null;
    melodySynth = null;
    ready = false;
    currentChord = null;
    currentMelody = null;
    grooveOn = false;
  }

  return {
    unlock,
    setChord,
    setMelodyNote,
    setGroove,
    setInstrument,
    dispose,
  };
}
