/**
 * geometry.js — 盤幾何 / 極座標 / 扇形命中(共用純函數,無 DOM、無副作用)。
 *
 * 這是 coordinateMapper、renderer 的共用幾何基礎。設計 §4.2 / §9。
 * 角度約定(全專案一致):**0° 指向正上方,順時針遞增**,單位為度。
 * 螢幕座標 y 向下,故「上」= y 變小、「右」= x 變大。
 * 此約定與 mockup 的 polar() 一致:slot i 佔角度 [i*step, (i+1)*step)。
 *
 * 純函數可單元測試(設計 §9:點 → 極座標 → 扇形塊命中、死區判定)。
 */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * 角度正規化到 [0, 360)。處理負角與 >=360(防呆,讓 slot 環繞 / hysteresis 穩定)。
 * @param {number} deg
 * @returns {number} [0,360)
 */
function normalizeDeg(deg) {
  let a = deg % 360;
  if (a < 0) a += 360;
  return a;
}

/**
 * 兩角度間的最短環繞角距(度,[0,180])。slot7 上界 360≡0 的環繞也正確。
 * @param {number} a 度
 * @param {number} b 度
 * @returns {number} [0,180]
 */
function shortestAngularDist(a, b) {
  const d = Math.abs(normalizeDeg(a) - normalizeDeg(b)) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * 極座標 → 笛卡爾座標。0° 朝正上方、順時針為正。
 * 與 mockup 一致:a = (deg-90)·π/180,x = cx + r·cos(a),y = cy + r·sin(a)。
 * @param {number} cx 圓心 x(像素)
 * @param {number} cy 圓心 y(像素)
 * @param {number} r  半徑(像素)
 * @param {number} deg 角度(度,0=上,順時針+)
 * @returns {{x:number, y:number}} 對應點(像素)
 */
export function polar(cx, cy, r, deg) {
  const a = (deg - 90) * DEG2RAD;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

/**
 * 點相對圓心的半徑(像素距離)。
 * @param {{x:number,y:number}} pt 點(像素)
 * @param {{cx:number,cy:number}} disk 含圓心的盤(像素)
 * @returns {number} 半徑(像素)
 */
export function radiusOf(pt, disk) {
  return Math.hypot(pt.x - disk.cx, pt.y - disk.cy);
}

/**
 * 點相對圓心的角度(度,0=正上方、順時針遞增、範圍 [0,360))。
 * polar 的精確逆運算:由 polar 得 dx = r·sin(deg)、dy = -r·cos(deg),
 * 故 deg = atan2(dx, -dy),再正規化到 [0,360)。
 * @param {{x:number,y:number}} pt 點(像素)
 * @param {{cx:number,cy:number}} disk 含圓心的盤(像素)
 * @returns {number} 角度(度,[0,360))
 */
export function angleOf(pt, disk) {
  const dx = pt.x - disk.cx;
  const dy = pt.y - disk.cy;
  return normalizeDeg(Math.atan2(dx, -dy) * RAD2DEG);
}

/**
 * 角度落在第幾塊(slot)。slot i 佔 [i*step, (i+1)*step),step=360/slots。
 * 先正規化角度(支援負角 / >360 / 360 環繞),再 floor;夾住浮點極端值。
 * @param {number} deg 角度(度)
 * @param {number} slots 塊數
 * @returns {number} slot index 0..slots-1
 */
export function slotForAngle(deg, slots) {
  const step = 360 / slots;
  const a = normalizeDeg(deg);
  // a ∈ [0,360),floor 結果 ∈ [0,slots-1];min 夾住 a 極接近 360 的浮點情形。
  return Math.min(slots - 1, Math.floor(a / step));
}

/**
 * 點是否落在中心死區內(半徑 < rIn)。
 * 邊界採嚴格小於:r=rIn(donut 內緣)屬於塊、非死區,與 §2.3 「死區半徑 = donut 內徑」一致。
 * @param {{x:number,y:number}} pt 點(像素)
 * @param {{cx:number,cy:number,rIn:number}} disk 盤(像素,rIn=死區/donut 內徑)
 * @returns {boolean} true=在死區(休息區)內
 */
export function isInDeadzone(pt, disk) {
  return radiusOf(pt, disk) < disk.rIn;
}

/**
 * 角度到「當前塊最近邊界」的角度餘量(度,[0, step/2]),供 hysteresis 判斷用。
 * 餘量越小代表越接近換塊;coordinateMapper 以「跨界後再多 HYSTERESIS_DEG」決定是否換塊。
 *
 * 定義:slot 佔 [slot*step, (slot+1)*step);取角度到兩邊界(以環繞最短角距)的較小值。
 * 塊正中心餘量最大 = step/2;恰在邊界餘量 = 0。
 * @param {number} deg 角度(度)
 * @param {number} slot 當前 slot index
 * @param {number} slots 塊數
 * @returns {number} 到最近邊界的角度餘量(度,[0, step/2])
 */
export function angleMarginToBoundary(deg, slot, slots) {
  const step = 360 / slots;
  const a = normalizeDeg(deg);
  const lower = slot * step;
  const upper = (slot + 1) * step;
  const toLower = shortestAngularDist(a, lower);
  const toUpper = shortestAngularDist(a, upper);
  return Math.min(toLower, toUpper);
}

/**
 * 產生一塊扇形(donut sector)的 SVG/Canvas path 描述,供 renderer 畫塊。
 * 角度約定同上(0=上、順時針)。對齊 mockup prototype 的 donut sector:
 *   外緣 a0→a1 順時針一段弧(sweep=1)、L 到內緣 a1、內緣 a1→a0 逆時針一段弧(sweep=0)、閉合。
 * 兩段 A 弧;large-arc 旗標依跨角(>180°)自動判斷。
 * @param {number} cx 圓心 x(像素)
 * @param {number} cy 圓心 y(像素)
 * @param {number} rIn 內徑(像素)
 * @param {number} rOut 外徑(像素)
 * @param {number} a0 起始角(度)
 * @param {number} a1 結束角(度)
 * @returns {string} SVG path "d" 字串(renderer 可用 Path2D 解析)
 */
export function sectorPath(cx, cy, rIn, rOut, a0, a1) {
  const o0 = polar(cx, cy, rOut, a0);
  const o1 = polar(cx, cy, rOut, a1);
  const i1 = polar(cx, cy, rIn, a1);
  const i0 = polar(cx, cy, rIn, a0);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const f = (n) => n.toFixed(1);
  return (
    `M ${f(o0.x)} ${f(o0.y)} ` +
    `A ${rOut} ${rOut} 0 ${large} 1 ${f(o1.x)} ${f(o1.y)} ` +
    `L ${f(i1.x)} ${f(i1.y)} ` +
    `A ${rIn} ${rIn} 0 ${large} 0 ${f(i0.x)} ${f(i0.y)} ` +
    `Z`
  );
}

// ───────────────────────── 旋律琴鍵(線性,2026-06-13) ─────────────────────────

/**
 * x 座標落在第幾個琴鍵。鍵區 [x0,x1] 等分 keys 段;夾住區外的 x(防呆)。
 * @param {number} x 設計空間像素 x
 * @param {{x0:number,x1:number,keys:number}} kb 琴鍵幾何(見 config.KEYBOARD)
 * @returns {number} 鍵 index 0..keys-1
 */
export function keyForX(x, kb) {
  const { x0, x1, keys } = kb;
  if (x1 <= x0 || keys <= 0) return 0;
  const t = (x - x0) / (x1 - x0);
  return Math.max(0, Math.min(keys - 1, Math.floor(t * keys)));
}

/**
 * 第 i 個琴鍵的水平邊界(設計空間像素)。供 renderer 畫鍵、mapper 換鍵遲滯用。
 * @param {number} i 鍵 index
 * @param {{x0:number,x1:number,keys:number}} kb 琴鍵幾何
 * @returns {{x0:number,x1:number}} 該鍵左右界
 */
export function keyBoundsX(i, kb) {
  const w = (kb.x1 - kb.x0) / kb.keys;
  return { x0: kb.x0 + i * w, x1: kb.x0 + (i + 1) * w };
}

/**
 * 第 i 個琴鍵的「視覺矩形」(等分後內縮 gap;設計空間像素)。in-shape 判定與 renderer 共用同一形狀。
 * @param {number} i 鍵 index
 * @param {{x0:number,x1:number,keys:number,gap:number,keyTop:number,keyBottom:number}} kb
 * @returns {{x:number,y:number,w:number,h:number}} 鍵矩形
 */
export function keyRect(i, kb) {
  const segW = (kb.x1 - kb.x0) / kb.keys;
  const half = kb.gap / 2;
  return { x: kb.x0 + i * segW + half, y: kb.keyTop, w: segW - kb.gap, h: kb.keyBottom - kb.keyTop };
}

/**
 * 點落在哪個琴鍵形狀內(in-shape 機制核心):手在某鍵矩形內 → 該鍵;在間隔 / 帶上下外 → null(靜音)。
 * margin>0 供遲滯用(已在某鍵時擴張其邊界,避免邊緣抖動進出)。鍵間 gap > 2×margin 確保不會同時屬於兩鍵。
 * @param {{x:number,y:number}} pt 點(設計空間像素)
 * @param {Object} kb config.KEYBOARD
 * @param {number} [margin=0] 邊界外擴(像素)
 * @returns {number|null} 鍵 index 或 null
 */
export function keyAtPoint(pt, kb, margin = 0) {
  if (pt.y < kb.keyTop - margin || pt.y > kb.keyBottom + margin) return null;
  const segW = (kb.x1 - kb.x0) / kb.keys;
  const half = kb.gap / 2;
  for (let i = 0; i < kb.keys; i++) {
    const kx0 = kb.x0 + i * segW + half;
    const kx1 = kb.x0 + (i + 1) * segW - half;
    if (pt.x >= kx0 - margin && pt.x <= kx1 + margin) return i;
  }
  return null;
}
