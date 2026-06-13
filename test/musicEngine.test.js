/**
 * musicEngine.test.js — musicEngine.js 單元測試(設計 §9)。
 *
 * 驗證 §3 樂理映射:
 *  - 右盤 slot → 五聲音(scale degree → MIDI 抽象,§3.1)。
 *  - 左盤 slot → 和弦(§3.2)。
 *  - setKey / setScale 做整體 transpose(§3.3)。
 *
 * 真實來源(SSOT)= design doc §3 + config.js 的 base 對照表。測試直接引用
 * config 的常數,避免在測試裡複寫魔術數字(改 config 即同步)。
 */
import { describe, it, expect } from 'vitest';
import { createMusicEngine } from '../src/musicEngine.js';
import {
  SLOTS,
  PENTATONIC_C_MIDI,
  CHORDS_C,
  SCALE_PRESETS,
  KEY_OFFSETS,
  DEFAULT_KEY,
  DEFAULT_SCALE,
} from '../src/config.js';

// ───────────────────────── 契約形狀 ─────────────────────────
describe('musicEngine — contract', () => {
  it('createMusicEngine returns the documented API', () => {
    const engine = createMusicEngine({ key: 'C', scale: 'pentatonic' });
    expect(typeof engine.chordForSlot).toBe('function');
    expect(typeof engine.noteForSlot).toBe('function');
    expect(typeof engine.setKey).toBe('function');
    expect(typeof engine.setScale).toBe('function');
    expect(typeof engine.getKey).toBe('function');
    expect(typeof engine.getScale).toBe('function');
  });

  it('預設值 = config.DEFAULT_KEY / DEFAULT_SCALE', () => {
    const engine = createMusicEngine();
    expect(engine.getKey()).toBe(DEFAULT_KEY);
    expect(engine.getScale()).toBe(DEFAULT_SCALE);
  });
});

// ───────────────────────── 右盤五聲音(§3.1) ─────────────────────────
describe('noteForSlot — 五聲音階(預設 C 大調 pentatonic)', () => {
  const engine = createMusicEngine({ key: 'C', scale: 'pentatonic' });

  it('slot 0..7 的 MIDI 等於 §3.1 的 [60,62,64,67,69,72,74,76]', () => {
    const got = Array.from({ length: SLOTS }, (_, k) => engine.noteForSlot(k).midi);
    expect(got).toEqual(PENTATONIC_C_MIDI);
  });

  it('每個 slot 回傳 { name:string, midi:number }', () => {
    const r = engine.noteForSlot(0);
    expect(typeof r.name).toBe('string');
    expect(r.name.length).toBeGreaterThan(0);
    expect(typeof r.midi).toBe('number');
    expect(Number.isInteger(r.midi)).toBe(true);
  });

  it('順時針(slot 遞增)音高單調遞增(§3.1)', () => {
    for (let k = 1; k < SLOTS; k++) {
      expect(engine.noteForSlot(k).midi).toBeGreaterThan(engine.noteForSlot(k - 1).midi);
    }
  });

  it('degree → 音高 抽象:5 度的 pentatonic 跨 8 塊時以八度循環(slot 5 = slot 0 + 12)', () => {
    expect(engine.noteForSlot(5).midi).toBe(engine.noteForSlot(0).midi + 12);
    expect(engine.noteForSlot(6).midi).toBe(engine.noteForSlot(1).midi + 12);
    expect(engine.noteForSlot(7).midi).toBe(engine.noteForSlot(2).midi + 12);
  });
});

// ───────────────────────── 左盤和弦(§3.2) ─────────────────────────
describe('chordForSlot — C 大調和弦(§3.2)', () => {
  const engine = createMusicEngine({ key: 'C', scale: 'pentatonic' });

  it('slot 0 = { name:"C", midi:[60,64,67] }', () => {
    expect(engine.chordForSlot(0)).toEqual({ name: 'C', midi: [60, 64, 67] });
  });

  it('全 8 塊和弦的 name + midi 等於 config.CHORDS_C(設計 §3.2 表)', () => {
    for (let k = 0; k < SLOTS; k++) {
      const r = engine.chordForSlot(k);
      expect(r.name).toBe(CHORDS_C[k].name);
      expect(r.midi).toEqual(CHORDS_C[k].midi);
    }
  });

  it('回傳的 midi 是 copy(呼叫端 mutate 不污染 base 表)', () => {
    const a = engine.chordForSlot(2);
    a.midi.push(999);
    const b = engine.chordForSlot(2);
    expect(b.midi).toEqual(CHORDS_C[2].midi);
  });

  it('和弦不受 scale preset 影響(scale 只管旋律)', () => {
    const penta = createMusicEngine({ key: 'C', scale: 'pentatonic' });
    const blues = createMusicEngine({ key: 'C', scale: 'blues' });
    for (let k = 0; k < SLOTS; k++) {
      expect(blues.chordForSlot(k).midi).toEqual(penta.chordForSlot(k).midi);
    }
  });
});

// ───────────────────────── 換調 transpose(§3.3) ─────────────────────────
describe('setKey — 整體半音 transpose(§3.3)', () => {
  it('setKey("G") → 旋律與和弦全部 +7 半音', () => {
    const c = createMusicEngine({ key: 'C', scale: 'pentatonic' });
    const g = createMusicEngine({ key: 'C', scale: 'pentatonic' });
    g.setKey('G');
    expect(g.getKey()).toBe('G');

    // 旋律 +7
    for (let k = 0; k < SLOTS; k++) {
      expect(g.noteForSlot(k).midi).toBe(c.noteForSlot(k).midi + KEY_OFFSETS.G);
    }
    // 和弦 +7
    for (let k = 0; k < SLOTS; k++) {
      const base = c.chordForSlot(k).midi;
      const moved = g.chordForSlot(k).midi;
      expect(moved).toEqual(base.map((m) => m + KEY_OFFSETS.G));
    }
  });

  it('每個 KEY_OFFSETS 的調都正確位移旋律 slot 0', () => {
    const c = createMusicEngine({ key: 'C' });
    const base = c.noteForSlot(0).midi; // 60
    for (const [key, offset] of Object.entries(KEY_OFFSETS)) {
      const e = createMusicEngine({ key });
      expect(e.noteForSlot(0).midi).toBe(base + offset);
    }
  });

  it('建構子帶 key 與 setKey 結果一致', () => {
    const built = createMusicEngine({ key: 'D', scale: 'pentatonic' });
    const set = createMusicEngine({ key: 'C', scale: 'pentatonic' });
    set.setKey('D');
    for (let k = 0; k < SLOTS; k++) {
      expect(set.noteForSlot(k).midi).toBe(built.noteForSlot(k).midi);
      expect(set.chordForSlot(k).midi).toEqual(built.chordForSlot(k).midi);
    }
  });

  it('和弦名隨 transpose 更新(C→G 後 slot 0 的根音應為 G,不可仍叫 "C")', () => {
    const g = createMusicEngine({ key: 'G', scale: 'pentatonic' });
    // slot 0 base 是 C 大三和弦,+7 後根音 = G,品質(major)不變 → 名為 "G"
    const r = g.chordForSlot(0);
    expect(r.midi).toEqual([67, 71, 74]);
    expect(r.name).toBe('G');
  });

  it('回到 C 還原(setKey 可逆,無漂移)', () => {
    const e = createMusicEngine({ key: 'C', scale: 'pentatonic' });
    const before = Array.from({ length: SLOTS }, (_, k) => e.noteForSlot(k).midi);
    e.setKey('A');
    e.setKey('C');
    const after = Array.from({ length: SLOTS }, (_, k) => e.noteForSlot(k).midi);
    expect(after).toEqual(before);
  });
});

// ───────────────────────── 換音階 preset transpose(§3.3) ─────────────────────────
describe('setScale — 換 preset 改旋律 degree(§3.3)', () => {
  it('setScale("major") → slot 依 major degrees [0,2,4,5,7,9,11] 取音', () => {
    const e = createMusicEngine({ key: 'C', scale: 'pentatonic' });
    e.setScale('major');
    expect(e.getScale()).toBe('major');
    const root = e.noteForSlot(0).midi; // C4 = 60
    const expected = Array.from({ length: SLOTS }, (_, k) => {
      const degs = SCALE_PRESETS.major;
      return root + degs[k % degs.length] + 12 * Math.floor(k / degs.length);
    });
    const got = Array.from({ length: SLOTS }, (_, k) => e.noteForSlot(k).midi);
    expect(got).toEqual(expected);
  });

  it('minor preset:slot 0 = root,slot 2 = root+3(小三度)', () => {
    const e = createMusicEngine({ key: 'C', scale: 'minor' });
    const root = e.noteForSlot(0).midi;
    expect(e.noteForSlot(2).midi).toBe(root + 3);
  });

  it('blues preset:7 塊 wrap(blues 有 6 度,slot 6 = slot 0 + 12)', () => {
    const e = createMusicEngine({ key: 'C', scale: 'blues' });
    expect(SCALE_PRESETS.blues.length).toBe(6);
    expect(e.noteForSlot(6).midi).toBe(e.noteForSlot(0).midi + 12);
  });

  it('scale + key 疊加:major 於 G 調 slot 0 = 60 + 7', () => {
    const e = createMusicEngine({ key: 'G', scale: 'major' });
    expect(e.noteForSlot(0).midi).toBe(60 + KEY_OFFSETS.G);
  });
});

// ───────────────────────── 防呆 ─────────────────────────
describe('musicEngine — 邊界與錯誤', () => {
  it('未知 key / scale 拋出明確錯誤', () => {
    const e = createMusicEngine();
    expect(() => e.setKey('H')).toThrow();
    expect(() => e.setScale('lydian')).toThrow();
    expect(() => createMusicEngine({ key: 'ZZ' })).toThrow();
    expect(() => createMusicEngine({ scale: 'nope' })).toThrow();
  });

  it('越界 slot 拋出明確錯誤', () => {
    const e = createMusicEngine();
    expect(() => e.noteForSlot(-1)).toThrow();
    expect(() => e.noteForSlot(SLOTS)).toThrow();
    expect(() => e.chordForSlot(-1)).toThrow();
    expect(() => e.chordForSlot(SLOTS)).toThrow();
  });
});
