/**
 * geometry.test.js — geometry.js 純函數單元測試(設計 §9)。
 *
 * 角度約定(全專案一致,對齊 config.js / mockup polar()):
 *   0° 指向正上方,順時針遞增,範圍 [0,360),單位為度。
 *   螢幕座標 y 向下,故「上」= y 變小、「右」= x 變大。
 *
 * 測項涵蓋:極座標往返、半徑、角度(cardinals + 環繞 + round-trip)、
 * 角度→塊(各塊 / 邊界 / 360 環繞)、死區(內 / 外 / 邊界)、
 * hysteresis margin(塊中心 / 近邊界 / 對稱)、扇形 path(錨點 = polar 輸出 + 結構)。
 */
import { describe, it, expect } from 'vitest';
import * as geometry from '../src/geometry.js';
import { polar, radiusOf, angleOf, slotForAngle, isInDeadzone, angleMarginToBoundary, sectorPath } from '../src/geometry.js';

// 浮點容差輔助
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

describe('geometry — contract', () => {
  it('exports expected pure functions', () => {
    expect(typeof geometry.polar).toBe('function');
    expect(typeof geometry.radiusOf).toBe('function');
    expect(typeof geometry.angleOf).toBe('function');
    expect(typeof geometry.slotForAngle).toBe('function');
    expect(typeof geometry.isInDeadzone).toBe('function');
    expect(typeof geometry.angleMarginToBoundary).toBe('function');
    expect(typeof geometry.sectorPath).toBe('function');
  });
});

describe('polar — 0°=上、順時針、螢幕 y 向下', () => {
  const cx = 100, cy = 100, r = 50;

  it('0° 指向正上方(y 變小)', () => {
    const p = polar(cx, cy, r, 0);
    expect(close(p.x, 100)).toBe(true);
    expect(close(p.y, 50)).toBe(true);
  });

  it('90° 指向正右方(x 變大)', () => {
    const p = polar(cx, cy, r, 90);
    expect(close(p.x, 150)).toBe(true);
    expect(close(p.y, 100)).toBe(true);
  });

  it('180° 指向正下方(y 變大)', () => {
    const p = polar(cx, cy, r, 180);
    expect(close(p.x, 100)).toBe(true);
    expect(close(p.y, 150)).toBe(true);
  });

  it('270° 指向正左方(x 變小)', () => {
    const p = polar(cx, cy, r, 270);
    expect(close(p.x, 50)).toBe(true);
    expect(close(p.y, 100)).toBe(true);
  });

  it('產生的點半徑恆等於 r', () => {
    for (const deg of [0, 17, 45, 123, 200, 359.5]) {
      const p = polar(cx, cy, r, deg);
      const d = Math.hypot(p.x - cx, p.y - cy);
      expect(close(d, r)).toBe(true);
    }
  });

  it('r=0 退化為圓心', () => {
    const p = polar(cx, cy, 0, 137);
    expect(close(p.x, cx)).toBe(true);
    expect(close(p.y, cy)).toBe(true);
  });
});

describe('radiusOf — 點到盤心距離', () => {
  const disk = { cx: 100, cy: 100 };

  it('圓心距離為 0', () => {
    expect(radiusOf({ x: 100, y: 100 }, disk)).toBeCloseTo(0, 10);
  });

  it('軸向距離', () => {
    expect(radiusOf({ x: 130, y: 100 }, disk)).toBeCloseTo(30, 10);
    expect(radiusOf({ x: 100, y: 60 }, disk)).toBeCloseTo(40, 10);
  });

  it('3-4-5 直角三角形', () => {
    expect(radiusOf({ x: 103, y: 104 }, disk)).toBeCloseTo(5, 10);
  });

  it('與 polar 一致(往返)', () => {
    const p = polar(disk.cx, disk.cy, 73.5, 222);
    expect(radiusOf(p, disk)).toBeCloseTo(73.5, 6);
  });
});

describe('angleOf — 0=上、順時針、[0,360)', () => {
  const disk = { cx: 100, cy: 100 };

  it('四個基本方向(螢幕 y 向下)', () => {
    expect(angleOf({ x: 100, y: 50 }, disk)).toBeCloseTo(0, 9);   // 上
    expect(angleOf({ x: 150, y: 100 }, disk)).toBeCloseTo(90, 9); // 右
    expect(angleOf({ x: 100, y: 150 }, disk)).toBeCloseTo(180, 9);// 下
    expect(angleOf({ x: 50, y: 100 }, disk)).toBeCloseTo(270, 9); // 左
  });

  it('回傳範圍恆在 [0,360)', () => {
    for (const [dx, dy] of [[1, -1], [1, 1], [-1, 1], [-1, -1], [0, -1], [-0.0001, -1]]) {
      const a = angleOf({ x: 100 + dx, y: 100 + dy }, disk);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(360);
    }
  });

  it('恰好正上方左側一點點 → 接近 360(不為負、不溢位)', () => {
    const a = angleOf({ x: 100 - 1e-6, y: 50 }, disk);
    expect(a).toBeGreaterThan(359.9);
    expect(a).toBeLessThan(360);
  });

  it('是 polar 的精確逆運算(round-trip 全角度)', () => {
    for (const deg of [0, 1, 30, 44.999, 45, 90, 135, 180, 225, 270, 315, 359, 359.999]) {
      const p = polar(disk.cx, disk.cy, 50, deg);
      const back = angleOf(p, disk);
      // 環繞距離
      const diff = Math.min(Math.abs(back - deg), 360 - Math.abs(back - deg));
      expect(diff).toBeLessThan(1e-6);
    }
  });
});

describe('slotForAngle — slot i 佔 [i*step,(i+1)*step), step=360/slots', () => {
  const SLOTS = 8; // step = 45°

  it('每塊中心落在正確 index(0..7)', () => {
    for (let i = 0; i < SLOTS; i++) {
      const mid = i * 45 + 22.5;
      expect(slotForAngle(mid, SLOTS)).toBe(i);
    }
  });

  it('塊起始邊界(含)歸入該塊', () => {
    expect(slotForAngle(0, SLOTS)).toBe(0);
    expect(slotForAngle(45, SLOTS)).toBe(1);
    expect(slotForAngle(90, SLOTS)).toBe(2);
    expect(slotForAngle(315, SLOTS)).toBe(7);
  });

  it('塊結束邊界(不含)歸入下一塊', () => {
    // 45 屬於 slot1,故 slot0 的上界以 44.999… 驗
    expect(slotForAngle(44.9999, SLOTS)).toBe(0);
    expect(slotForAngle(89.9999, SLOTS)).toBe(1);
    expect(slotForAngle(359.9999, SLOTS)).toBe(7);
  });

  it('360 環繞回 slot 0;>360 也正確取模', () => {
    expect(slotForAngle(360, SLOTS)).toBe(0);
    expect(slotForAngle(405, SLOTS)).toBe(1);   // 405 = 45
    expect(slotForAngle(720 + 22.5, SLOTS)).toBe(0);
  });

  it('負角度也正確取模(防呆)', () => {
    expect(slotForAngle(-1, SLOTS)).toBe(7);    // -1 ≡ 359 → slot7
    expect(slotForAngle(-45, SLOTS)).toBe(7);   // -45 ≡ 315 → slot7
  });

  it('不同塊數:6 塊 step=60', () => {
    expect(slotForAngle(0, 6)).toBe(0);
    expect(slotForAngle(59.999, 6)).toBe(0);
    expect(slotForAngle(60, 6)).toBe(1);
    expect(slotForAngle(330, 6)).toBe(5);
  });

  it('回傳值恆在 [0,slots) 且為整數', () => {
    for (let deg = -720; deg <= 720; deg += 7.3) {
      const s = slotForAngle(deg, SLOTS);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(SLOTS);
      expect(Number.isInteger(s)).toBe(true);
    }
  });
});

describe('isInDeadzone — 半徑 < rIn 為 true(中心休息區)', () => {
  const disk = { cx: 200, cy: 200, rIn: 73.5 };

  it('圓心在死區內', () => {
    expect(isInDeadzone({ x: 200, y: 200 }, disk)).toBe(true);
  });

  it('死區內任意方向的點', () => {
    expect(isInDeadzone({ x: 200, y: 200 - 50 }, disk)).toBe(true); // r=50<73.5
    expect(isInDeadzone({ x: 200 + 70, y: 200 }, disk)).toBe(true); // r=70<73.5
  });

  it('死區外的點為 false', () => {
    expect(isInDeadzone({ x: 200, y: 200 - 100 }, disk)).toBe(false); // r=100
    expect(isInDeadzone({ x: 200 + 73.6, y: 200 }, disk)).toBe(false);
  });

  it('恰在邊界 r=rIn 視為「不在死區」(>= rIn 即離開、進塊)', () => {
    // 半徑剛好等於 rIn:donut 內緣即塊的起點,屬於塊、非死區
    expect(isInDeadzone({ x: 200 + 73.5, y: 200 }, disk)).toBe(false);
  });

  it('邊界內外微小差(±EPS)行為穩定', () => {
    expect(isInDeadzone({ x: 200 + (73.5 - 1e-6), y: 200 }, disk)).toBe(true);
    expect(isInDeadzone({ x: 200 + (73.5 + 1e-6), y: 200 }, disk)).toBe(false);
  });

  it('用 polar 在 rIn 內外生成點來驗', () => {
    const inside = polar(disk.cx, disk.cy, disk.rIn * 0.5, 123);
    const outside = polar(disk.cx, disk.cy, disk.rIn * 1.5, 123);
    expect(isInDeadzone(inside, disk)).toBe(true);
    expect(isInDeadzone(outside, disk)).toBe(false);
  });
});

describe('angleMarginToBoundary — 到當前塊最近邊界的角度餘量(hysteresis 用)', () => {
  const SLOTS = 8; // step 45,half=22.5

  it('塊正中心 → 餘量最大 = step/2', () => {
    for (let i = 0; i < SLOTS; i++) {
      const mid = i * 45 + 22.5;
      expect(angleMarginToBoundary(mid, i, SLOTS)).toBeCloseTo(22.5, 6);
    }
  });

  it('靠近邊界 → 餘量趨近 0', () => {
    // slot0 = [0,45),角度 44 距上界 1 度
    expect(angleMarginToBoundary(44, 0, SLOTS)).toBeCloseTo(1, 6);
    // 角度 1 距下界 1 度
    expect(angleMarginToBoundary(1, 0, SLOTS)).toBeCloseTo(1, 6);
  });

  it('恰在邊界 → 餘量 0', () => {
    expect(angleMarginToBoundary(45, 1, SLOTS)).toBeCloseTo(0, 6); // slot1 下界
    expect(angleMarginToBoundary(0, 0, SLOTS)).toBeCloseTo(0, 6);  // slot0 下界
  });

  it('餘量恆非負且 <= step/2', () => {
    for (let i = 0; i < SLOTS; i++) {
      for (let off = 0; off <= 45; off += 3) {
        const m = angleMarginToBoundary(i * 45 + off, i, SLOTS);
        expect(m).toBeGreaterThanOrEqual(-1e-9);
        expect(m).toBeLessThanOrEqual(22.5 + 1e-9);
      }
    }
  });

  it('環繞塊(slot7 上界=360≡0)邊界也正確', () => {
    // slot7 = [315,360),中心 337.5
    expect(angleMarginToBoundary(337.5, 7, SLOTS)).toBeCloseTo(22.5, 6);
    // 359 距上界(360) 1 度
    expect(angleMarginToBoundary(359, 7, SLOTS)).toBeCloseTo(1, 6);
    // 316 距下界(315) 1 度
    expect(angleMarginToBoundary(316, 7, SLOTS)).toBeCloseTo(1, 6);
  });

  it('hysteresis 判定情境:塊中心很穩、近邊界餘量 < HYSTERESIS_DEG(7)', () => {
    // slot0 中心很穩(22.5 >> 7)
    expect(angleMarginToBoundary(22.5, 0, SLOTS)).toBeGreaterThan(7);
    // 接近邊界(餘量 5 < 7)
    expect(angleMarginToBoundary(40, 0, SLOTS)).toBeLessThan(7);
  });
});

describe('sectorPath — donut 扇形 path(錨點 = polar 輸出)', () => {
  const cx = 100, cy = 100, rIn = 40, rOut = 90, a0 = 0, a1 = 45;

  it('回傳非空字串,M 起始、Z 結束', () => {
    const d = sectorPath(cx, cy, rIn, rOut, a0, a1);
    expect(typeof d).toBe('string');
    expect(d.length).toBeGreaterThan(0);
    expect(d.trim().startsWith('M')).toBe(true);
    expect(d.trim().endsWith('Z')).toBe(true);
  });

  it('含兩段弧(donut 內外緣各一 A 指令)', () => {
    const d = sectorPath(cx, cy, rIn, rOut, a0, a1);
    const arcs = (d.match(/A/g) || []).length;
    expect(arcs).toBe(2);
  });

  it('path 內可解析出四個角錨點,且等於 polar(rOut/rIn, a0/a1)', () => {
    const d = sectorPath(cx, cy, rIn, rOut, a0, a1);
    // 抽出所有數字(座標),驗證四個錨點存在
    const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    const oOut0 = polar(cx, cy, rOut, a0);
    const oOut1 = polar(cx, cy, rOut, a1);
    const oIn0 = polar(cx, cy, rIn, a0);
    const oIn1 = polar(cx, cy, rIn, a1);
    const hasPoint = (pt) => {
      for (let i = 0; i + 1 < nums.length; i++) {
        if (close(nums[i], pt.x, 0.2) && close(nums[i + 1], pt.y, 0.2)) return true;
      }
      return false;
    };
    expect(hasPoint(oOut0)).toBe(true);
    expect(hasPoint(oOut1)).toBe(true);
    expect(hasPoint(oIn0)).toBe(true);
    expect(hasPoint(oIn1)).toBe(true);
  });

  it('large-arc-flag:小於 180° 的扇形為 0', () => {
    const d = sectorPath(cx, cy, rIn, rOut, 0, 45);
    // 形如 "A rOut rOut 0 <L> 1 ..." — 取第一段弧的旗標
    const m = d.match(/A\s+[\d.]+\s+[\d.]+\s+0\s+(\d)\s+\d/);
    expect(m).not.toBeNull();
    expect(m[1]).toBe('0');
  });

  it('large-arc-flag:大於 180° 的扇形為 1', () => {
    const d = sectorPath(cx, cy, rIn, rOut, 0, 200);
    const m = d.match(/A\s+[\d.]+\s+[\d.]+\s+0\s+(\d)\s+\d/);
    expect(m).not.toBeNull();
    expect(m[1]).toBe('1');
  });
});
