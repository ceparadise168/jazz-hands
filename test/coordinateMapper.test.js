/**
 * coordinateMapper.test.js — coordinateMapper.js 單元測試(設計 §9)。
 *
 * 驗證(設計 §2.2 狀態機 + §2.3 防誤觸):
 *  - 契約形狀(update / reset)。
 *  - 指尖在死區內 → REST / zone=null;指尖移到某塊 → ACTIVE + 正確 zone + changed。
 *  - 邊界附近抖動(< hysteresis)→ zone 不變、changed=false;超過 hysteresis 才換。
 *  - 死區進出(REST↔ACTIVE)的 changed 旗標。
 *  - 左右分盤(§2.1):依「畫面左右位置」分盤(畫面為水平鏡像);同半多指取最靠近圓心者。
 *  - 左盤、右盤各自獨立狀態機。
 *
 * 測試座標策略:
 *  - 盤幾何在「設計空間」(config.DISKS,1280×720),故 update 的 viewport 一律傳 DESIGN_VIEW,
 *    使 normalized→像素換算落在盤所在的設計空間(見回報的 geometry/契約假設)。
 *  - 用 geometry.polar 由 (盤, 角度, 半徑) 算出「設計空間像素」,再反算成 raw normalized:
 *    mapper 會對 x 做鏡像 (1-rawX)*W,故這裡 rawX = 1 - px/W、rawY = py/H,確保來回鏡像對得上。
 *  - One-Euro 平滑會有收斂延遲:測「穩態」時連餵多幀讓濾波器收斂後再斷言。
 */
import { describe, it, expect } from 'vitest';
import { createMapper } from '../src/coordinateMapper.js';
import { DISKS, DESIGN_VIEW, SLOTS, HYSTERESIS_DEG, melodyGeom } from '../src/config.js';
import { polar, keyRect } from '../src/geometry.js';

const W = DESIGN_VIEW.width;
const H = DESIGN_VIEW.height;
const STEP = 360 / SLOTS; // 45°
const MEL = melodyGeom('thirds'); // 生效的右手幾何(三度排列)

/** 由 (盤, 角度°, 半徑px) 產生一個「未鏡像的 raw normalized」指尖。 */
function tipAt(disk, deg, r) {
  const p = polar(disk.cx, disk.cy, r, deg); // 設計空間像素
  return { x: 1 - p.x / W, y: p.y / H };     // 反鏡像 → raw normalized
}

/** 第 i 個 pad 中心(設計空間像素)。 */
function padCenter(i) {
  const r = keyRect(i, MEL);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}
/** 在第 i 個 pad 形狀內(in-shape 發聲)→ 未鏡像 raw normalized。 */
function kbInKey(i) {
  const c = padCenter(i);
  return { x: 1 - c.x / W, y: c.y / H };
}
/** 兩 pad 中心連線中點(落在 pad 之間的靜音空白)→ 未鏡像 raw normalized。 */
function kbBetween(i, j) {
  const a = padCenter(i);
  const b = padCenter(j);
  return { x: 1 - ((a.x + b.x) / 2) / W, y: ((a.y + b.y) / 2) / H };
}
/** 在所有 pad 上方(靜音)→ 未鏡像 raw normalized。 */
function kbAbove() {
  const c = padCenter(0);
  return { x: 1 - c.x / W, y: (MEL.topY - 60) / H };
}

/** slot k 的角度中心(度)。 */
function slotCenterDeg(k) {
  return k * STEP + STEP / 2;
}

/** 餵同一組 tips n 幀,回傳最後一幀結果(讓 One-Euro 收斂到穩態)。 */
function settle(mapper, tips, frames = 12) {
  let res;
  for (let i = 0; i < frames; i++) res = mapper.update(tips, DESIGN_VIEW);
  return res;
}

const midR = (DISKS.L.rIn + DISKS.L.rOut) / 2; // 塊中段半徑,穩穩落在 donut 內

describe('coordinateMapper — contract', () => {
  it('createMapper returns update + reset', () => {
    const mapper = createMapper({ disks: DISKS, keyboard: MEL });
    expect(typeof mapper.update).toBe('function');
    expect(typeof mapper.reset).toBe('function');
  });

  it('update returns L and R disk states each frame', () => {
    const mapper = createMapper({ disks: DISKS, keyboard: MEL });
    const res = mapper.update([], DESIGN_VIEW);
    expect(res).toHaveProperty('L');
    expect(res).toHaveProperty('R');
    for (const d of [res.L, res.R]) {
      expect(d).toHaveProperty('state');
      expect(d).toHaveProperty('zone');
      expect(d).toHaveProperty('changed');
    }
  });
});

describe('coordinateMapper — REST / no hands', () => {
  it('no tips → both disks REST, zone null, not present', () => {
    const mapper = createMapper({ disks: DISKS, keyboard: MEL });
    const res = mapper.update([], DESIGN_VIEW);
    expect(res.L.state).toBe('REST');
    expect(res.L.zone).toBe(null);
    expect(res.L.present).toBe(false);
    expect(res.R.state).toBe('REST');
    expect(res.R.zone).toBe(null);
    expect(res.R.present).toBe(false);
  });

  it('tip inside the deadzone (center) → present but REST, zone null', () => {
    const mapper = createMapper({ disks: DISKS, keyboard: MEL });
    // 半徑 < rIn(嚴格小於)→ 死區內
    const tip = tipAt(DISKS.L, 0, DISKS.L.rIn * 0.5);
    const res = settle(mapper, [tip]);
    expect(res.L.present).toBe(true);
    expect(res.L.state).toBe('REST');
    expect(res.L.zone).toBe(null);
  });
});

describe('coordinateMapper — ACTIVE / zone mapping (left disk = chords)', () => {
  it('tip out to slot 0 (up) → ACTIVE zone 0, changed on entry', () => {
    const mapper = createMapper({ disks: DISKS, keyboard: MEL });
    const res = settle(mapper, [tipAt(DISKS.L, slotCenterDeg(0), midR)]);
    expect(res.L.state).toBe('ACTIVE');
    expect(res.L.zone).toBe(0);
  });

  it('REST → ACTIVE transition sets changed=true exactly on the transition frame', () => {
    const mapper = createMapper({ disks: DISKS, keyboard: MEL });
    // 第一幀就從死區外進塊 2;第一幀 One-Euro 無歷史 → 直接近 raw,應立即 ACTIVE。
    const first = mapper.update([tipAt(DISKS.L, slotCenterDeg(2), midR)], DESIGN_VIEW);
    expect(first.L.state).toBe('ACTIVE');
    expect(first.L.zone).toBe(2);
    expect(first.L.changed).toBe(true);
    // 維持同塊 → changed 變 false
    const next = mapper.update([tipAt(DISKS.L, slotCenterDeg(2), midR)], DESIGN_VIEW);
    expect(next.L.changed).toBe(false);
    expect(next.L.zone).toBe(2);
  });

  it('each of the 8 slots maps to its index (CW from up)', () => {
    for (let k = 0; k < SLOTS; k++) {
      const mapper = createMapper({ disks: DISKS, keyboard: MEL });
      const res = settle(mapper, [tipAt(DISKS.L, slotCenterDeg(k), midR)]);
      expect(res.L.zone).toBe(k);
      expect(res.L.state).toBe('ACTIVE');
    }
  });

  it('ACTIVE(k) → REST when returning to deadzone sets changed=true', () => {
    const mapper = createMapper({ disks: DISKS, keyboard: MEL });
    settle(mapper, [tipAt(DISKS.L, slotCenterDeg(3), midR)]);
    const back = settle(mapper, [tipAt(DISKS.L, 0, DISKS.L.rIn * 0.3)]);
    expect(back.L.state).toBe('REST');
    expect(back.L.zone).toBe(null);
    // 最後一幀已穩態(前一幀就回到 REST),所以單看 changed 不可靠;改驗單幀轉換
    const m2 = createMapper({ disks: DISKS, keyboard: MEL });
    settle(m2, [tipAt(DISKS.L, slotCenterDeg(3), midR)]);
    const t = m2.update([tipAt(DISKS.L, 0, DISKS.L.rIn * 0.3)], DESIGN_VIEW);
    expect(t.L.state).toBe('REST');
    expect(t.L.changed).toBe(true);
  });
});

describe('coordinateMapper — hysteresis (boundary anti-jitter, §2.3.2)', () => {
  it('crossing a boundary by LESS than hysteresis does NOT switch zone', () => {
    const mapper = createMapper({ disks: DISKS, keyboard: MEL });
    // 先穩定在塊 1 中心
    let res = settle(mapper, [tipAt(DISKS.L, slotCenterDeg(1), midR)]);
    expect(res.L.zone).toBe(1);
    // 邊界 1|2 在 90°;越界進塊 2 側,但只多越 HYSTERESIS_DEG-2 度(< margin)→ 不該換
    const justOver = 90 + (HYSTERESIS_DEG - 2);
    res = settle(mapper, [tipAt(DISKS.L, justOver, midR)]);
    expect(res.L.zone).toBe(1); // 仍黏在 1
    expect(res.L.changed).toBe(false);
  });

  it('crossing a boundary by MORE than hysteresis DOES switch zone', () => {
    const mapper = createMapper({ disks: DISKS, keyboard: MEL });
    settle(mapper, [tipAt(DISKS.L, slotCenterDeg(1), midR)]);
    // 越界進塊 2 側,多越 HYSTERESIS_DEG+5 度(> margin)→ 應換到 2
    const wellOver = 90 + (HYSTERESIS_DEG + 5);
    const res = settle(mapper, [tipAt(DISKS.L, wellOver, midR)]);
    expect(res.L.zone).toBe(2);
  });

  it('jittering back and forth across a boundary within hysteresis never flips the zone', () => {
    const mapper = createMapper({ disks: DISKS, keyboard: MEL });
    settle(mapper, [tipAt(DISKS.L, slotCenterDeg(2), midR)]); // 安定在塊 2
    const boundary = 90; // 2|1 共用邊界
    const zones = [];
    for (let i = 0; i < 10; i++) {
      // 在邊界兩側小幅來回,皆 < hysteresis
      const deg = boundary + (i % 2 === 0 ? (HYSTERESIS_DEG - 3) : -(HYSTERESIS_DEG - 3));
      const r = mapper.update([tipAt(DISKS.L, deg, midR)], DESIGN_VIEW);
      zones.push(r.L.zone);
    }
    // 全程不得亂跳:只能是原本的 2
    expect(zones.every((z) => z === 2)).toBe(true);
  });
});

describe('coordinateMapper — left/right disk split (§2.1, mirrored view)', () => {
  it('a tip in the screen-LEFT half drives L; R stays REST', () => {
    const mapper = createMapper({ disks: DISKS, keyboard: MEL });
    const res = settle(mapper, [tipAt(DISKS.L, slotCenterDeg(0), midR)]);
    expect(res.L.present).toBe(true);
    expect(res.L.state).toBe('ACTIVE');
    expect(res.R.present).toBe(false);
    expect(res.R.state).toBe('REST');
  });

  it('a tip in the screen-RIGHT half (pressed) drives R keyboard; L stays REST', () => {
    const mapper = createMapper({ disks: DISKS, keyboard: MEL });
    const res = settle(mapper, [kbInKey(4)]);
    expect(res.R.present).toBe(true);
    expect(res.R.state).toBe('ACTIVE');
    expect(res.R.zone).toBe(4);
    expect(res.L.present).toBe(false);
    expect(res.L.state).toBe('REST');
  });

  it('two tips (one per half) drive chord disk + melody keyboard independently', () => {
    const mapper = createMapper({ disks: DISKS, keyboard: MEL });
    const tips = [tipAt(DISKS.L, slotCenterDeg(1), midR), kbInKey(5)];
    const res = settle(mapper, tips);
    expect(res.L.state).toBe('ACTIVE');
    expect(res.L.zone).toBe(1);
    expect(res.R.state).toBe('ACTIVE');
    expect(res.R.zone).toBe(5);
  });

  it('two tips in the SAME half → pick the one nearest that disk center', () => {
    const mapper = createMapper({ disks: DISKS, keyboard: MEL });
    // 兩指都在畫面左半:一個落在塊 0(midR,離圓心遠),一個更靠近圓心(死區邊緣外一點點,塊 3)
    const far = tipAt(DISKS.L, slotCenterDeg(0), DISKS.L.rOut * 0.95); // 較遠
    const near = tipAt(DISKS.L, slotCenterDeg(3), DISKS.L.rIn + 4);    // 較近圓心
    const res = settle(mapper, [far, near]);
    // 取最靠近圓心者 → 應反映塊 3,而非塊 0
    expect(res.L.zone).toBe(3);
  });
});

describe('coordinateMapper — 旋律 2D pad in-shape(§2.2 melody, 2026-06-13)', () => {
  it('在某 pad 形狀內 → ACTIVE、zone = 該 pad、aim = 該 pad', () => {
    const m = createMapper({ disks: DISKS, keyboard: MEL });
    const res = settle(m, [kbInKey(3)]);
    expect(res.R.present).toBe(true);
    expect(res.R.state).toBe('ACTIVE');
    expect(res.R.zone).toBe(3);
    expect(res.R.aim).toBe(3);
  });

  it('第 8 鍵(高八度 C,index 7)可達 → ACTIVE、zone = 7(回歸:高 C 不可消失)', () => {
    const m = createMapper({ disks: DISKS, keyboard: MEL });
    const res = settle(m, [kbInKey(7)]);
    expect(res.R.state).toBe('ACTIVE');
    expect(res.R.zone).toBe(7);
  });

  it('快速經過(停留 < dwell)不發聲;停留夠久才確認發聲', () => {
    const m = createMapper({ disks: DISKS, keyboard: MEL });
    const tip = kbInKey(3);
    m.update([tip], DESIGN_VIEW, 1 / 60);
    const quick = m.update([tip], DESIGN_VIEW, 1 / 60); // 累積 ~33ms < 預設換音 dwell 150ms
    expect(quick.R.state).toBe('REST'); // 尚未停留足夠 → 不發聲(等同快速經過)
    let res;
    for (let i = 0; i < 10; i++) res = m.update([tip], DESIGN_VIEW, 1 / 60); // 累積 > dwell
    expect(res.R.state).toBe('ACTIVE');
    expect(res.R.zone).toBe(3);
  });

  it('同音重觸用較低 dwell:重觸同一音比換到不同音更快確認', () => {
    const r3 = keyRect(3, MEL);
    const above3 = { x: 1 - (r3.x + r3.w / 2) / W, y: (r3.y - 40) / H }; // pad3 正上方(靜音)

    const sameM = createMapper({ disks: DISKS, keyboard: MEL });
    sameM.setDwell(200, 20); // 換音 200ms、同音 20ms
    settle(sameM, [kbInKey(3)], 30); // 充分停留發聲 pad3(>200ms)→ lastPlayed=3
    settle(sameM, [above3]); // 抬到 pad3 上方靜音(lastPlayed 仍=3)
    let same; // 回到同音 pad3:10 幀累積 > 同音 20ms → 確認
    for (let i = 0; i < 10; i++) same = sameM.update([kbInKey(3)], DESIGN_VIEW, 1 / 60);
    expect(same.R.state).toBe('ACTIVE');
    expect(same.R.zone).toBe(3);

    const diffM = createMapper({ disks: DISKS, keyboard: MEL });
    diffM.setDwell(200, 20);
    settle(diffM, [kbInKey(3)], 30); // lastPlayed=3
    settle(diffM, [above3]);
    let diff; // 換到不同音 pad5:10 幀(≤167ms)< 換音 200ms → 仍未確認
    for (let i = 0; i < 10; i++) diff = diffM.update([kbInKey(5)], DESIGN_VIEW, 1 / 60);
    expect(diff.R.state).toBe('REST');
  });

  it('在 pad 之間的空白 → REST(靜音)', () => {
    const m = createMapper({ disks: DISKS, keyboard: MEL });
    const res = settle(m, [kbBetween(0, 2)]); // C 與 E 之間(上排水平空隙)
    expect(res.R.present).toBe(true);
    expect(res.R.state).toBe('REST');
    expect(res.R.zone).toBe(null);
  });

  it('在所有 pad 上方 → REST(靜音)', () => {
    const m = createMapper({ disks: DISKS, keyboard: MEL });
    const res = settle(m, [kbAbove()]);
    expect(res.R.state).toBe('REST');
    expect(res.R.zone).toBe(null);
  });

  it('pad → 空白 → 相鄰 pad:中途靜音、抵達才換音(無經過誤觸)', () => {
    const m = createMapper({ disks: DISKS, keyboard: MEL });
    expect(settle(m, [kbInKey(2)]).R.zone).toBe(2);
    expect(settle(m, [kbBetween(2, 3)]).R.state).toBe('REST');
    expect(settle(m, [kbInKey(3)]).R.zone).toBe(3);
  });

  it('右半無手 → R REST、不 present', () => {
    const m = createMapper({ disks: DISKS, keyboard: MEL });
    const res = settle(m, [tipAt(DISKS.L, slotCenterDeg(0), midR)]); // 只有左手
    expect(res.R.present).toBe(false);
    expect(res.R.state).toBe('REST');
  });
});

describe('coordinateMapper — 旋律 pizza 圓盤模式(kind:disk, 扇形 + 中心休息 + dwell)', () => {
  const PIZZA = melodyGeom('pizza');
  const midRp = (PIZZA.rIn + PIZZA.rOut) / 2;
  const step7 = 360 / PIZZA.slots;
  const sector = (k) => tipAt(PIZZA, step7 * k + step7 / 2, midRp); // 扇形 k 中心

  it('停留扇形夠久 → ACTIVE 該音;回中心死區 → REST', () => {
    const m = createMapper({ disks: DISKS, keyboard: PIZZA });
    const out = settle(m, [sector(3)]); // 扇形 3(F),settle 200ms > dwell
    expect(out.R.state).toBe('ACTIVE');
    expect(out.R.zone).toBe(3);
    const center = settle(m, [tipAt(PIZZA, 0, PIZZA.rIn * 0.4)]); // 中心死區
    expect(center.R.state).toBe('REST');
    expect(center.R.zone).toBe(null);
  });

  it('快速掃過扇形(停留 < dwell)不發聲;停留夠久才確認(跟琴鍵同款 dwell)', () => {
    const m = createMapper({ disks: DISKS, keyboard: PIZZA });
    const tip = sector(3);
    m.update([tip], DESIGN_VIEW, 1 / 60);
    const quick = m.update([tip], DESIGN_VIEW, 1 / 60); // 累積 ~33ms < 預設換音 dwell 150ms
    expect(quick.R.state).toBe('REST');
    let res;
    for (let i = 0; i < 10; i++) res = m.update([tip], DESIGN_VIEW, 1 / 60); // 累積 > dwell
    expect(res.R.state).toBe('ACTIVE');
    expect(res.R.zone).toBe(3);
  });

  it('靈敏度(setDwell)確實套用到 pizza:換音 dwell 調高 → 同樣停留時間不發聲', () => {
    const m = createMapper({ disks: DISKS, keyboard: PIZZA });
    m.setDwell(300, 20); // 換音 dwell 拉到 300ms
    const tip = sector(3);
    let res;
    for (let i = 0; i < 10; i++) res = m.update([tip], DESIGN_VIEW, 1 / 60); // ~167ms < 300ms
    expect(res.R.state).toBe('REST'); // dwell 確實生效在圓盤上
    for (let i = 0; i < 12; i++) res = m.update([tip], DESIGN_VIEW, 1 / 60); // 再累積 > 300ms
    expect(res.R.state).toBe('ACTIVE');
    expect(res.R.zone).toBe(3);
  });
});

describe('melody 排列 — 8 鍵都留在 16:10 安全區內(回歸:加高八度 C 後最右鍵不可被裁切)', () => {
  // cover 在 16:10(最常見筆電比例)會裁掉設計空間 x<64 與 x>1216;8 鍵須全落在此帶內。
  const SAFE_L = 64;
  const SAFE_R = 1216;
  for (const mode of ['row', 'thirds']) {
    it(`${mode}:8 鍵、每鍵左右緣 ∈ [${SAFE_L}, ${SAFE_R}]`, () => {
      const kb = melodyGeom(mode);
      expect(kb.layout.length).toBe(8); // 含高八度 C
      for (let i = 0; i < kb.layout.length; i++) {
        const r = keyRect(i, kb);
        expect(r.x).toBeGreaterThanOrEqual(SAFE_L);
        expect(r.x + r.w).toBeLessThanOrEqual(SAFE_R);
        expect(r.x).toBeGreaterThan(640 - r.w); // 主體仍在中線 640 右側(分盤歸右手)
      }
    });
  }
});

describe('coordinateMapper — reset', () => {
  it('reset clears state so next ACTIVE entry reports changed=true again', () => {
    const mapper = createMapper({ disks: DISKS, keyboard: MEL });
    const a = mapper.update([tipAt(DISKS.L, slotCenterDeg(2), midR)], DESIGN_VIEW);
    expect(a.L.changed).toBe(true);
    mapper.update([tipAt(DISKS.L, slotCenterDeg(2), midR)], DESIGN_VIEW); // changed=false now
    mapper.reset();
    const b = mapper.update([tipAt(DISKS.L, slotCenterDeg(2), midR)], DESIGN_VIEW);
    expect(b.L.changed).toBe(true); // reset 後重新視為新進入
  });
});
