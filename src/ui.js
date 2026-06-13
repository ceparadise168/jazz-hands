/**
 * ui.js — DOM 控制層(設計 §4.1 / §6 / §8)。
 *
 * 職責:頂部玻璃控制列(LIVE / 名稱 / scale preset / key / groove toggle+BPM / 音色)、
 * 底部提示列、覆蓋層(開始按鈕 / 載入態 / 錯誤卡片)。把使用者操作經 onChange 上拋,
 * 由 app 套用到 musicEngine / audioEngine。隱私聲明(相機本地處理)在 UI 明講(設計 §7)。
 *
 * 掛載點(見 index.html):#ui-topbar / #ui-hint / #ui-overlay,統稱 root 群組。
 *
 * 設計原則:
 *  - 此模組是 I/O 邊界(DOM 副作用),不含樂理 / 幾何邏輯。
 *  - 控制列的「選項真相」讀 config(SCALE_PRESETS / KEY_OFFSETS),不在 UI 硬寫一份清單,
 *    避免與 musicEngine 兩處漂移(name = single source,新增 preset 只改 config)。
 *  - 控制項變更只「上拋」onChange,不直接碰其他模組;外部狀態回灌走 setGroove/setScale/setKey。
 */

import {
  SCALE_PRESETS,
  KEY_OFFSETS,
  BPM,
  GROOVE_DEFAULT_ON,
} from './config.js';

/**
 * @typedef {Object} UIChange onChange 事件(discriminated union by `type`)
 * @property {'start'|'scale'|'key'|'groove'|'bpm'|'instrument'} type 事件類型
 * @property {string} [scale] type==='scale':新音階 preset
 * @property {string} [key] type==='key':新調
 * @property {boolean} [groove] type==='groove':律動開關
 * @property {number} [bpm] type==='bpm':新 BPM
 * @property {string} [chordInst] type==='instrument':和弦音色
 * @property {string} [melodyInst] type==='instrument':旋律音色
 */

/**
 * @callback OnUIChange
 * @param {UIChange} change
 * @returns {void}
 */

// ───────────────────────── 控制列選項標籤 ─────────────────────────
/**
 * 音階 preset 的中文顯示名(key 對齊 config.SCALE_PRESETS)。
 * 只放「顯示文案」,音程資料仍以 config 為真相;preset 鍵不在此表 → fallback 顯示原鍵。
 */
const SCALE_LABELS = {
  pentatonic: '五聲',
  major: '大調',
  minor: '小調',
  blues: '藍調',
};

/**
 * 音色選項(設計 §3.3 / §10 stretch:資料結構先預留)。
 * id 給 audioEngine.setInstrument 用;label 為顯示文案。
 * chord/melody 各一份預設,目前共用同一組 id 池。
 */
const INSTRUMENTS = [
  { id: 'epiano', label: '電鋼琴' },
  { id: 'synth', label: '合成器' },
  { id: 'pluck', label: '撥弦' },
];

/** groove BPM 可調範圍(設計 §3.4 預設 92)。 */
const BPM_MIN = 60;
const BPM_MAX = 160;

/** 狀態 → 底部提示左側的運作狀態文案(設計 §8 各情境)。 */
const STATUS_TEXT = {
  idle: '點「開始」啟動鏡頭',
  loading: '載入手部追蹤模型…',
  live: '運作中',
  'no-hand': '把手舉到鏡頭前 ✋',
  error: '發生錯誤',
};

/**
 * 建立 UI 控制層。
 * @param {Object} opts
 * @param {{topbar:HTMLElement, hint:HTMLElement, overlay:HTMLElement}} opts.root 三個掛載容器
 * @param {OnUIChange} opts.onChange 控制項變更回呼
 * @returns {{
 *   setStatus: (status: 'idle'|'loading'|'live'|'no-hand'|'error', detail?: string) => void,
 *   showStart: (onStart: () => void) => void,
 *   showError: (message: string, onRetry: () => void) => void,
 *   hideOverlay: () => void,
 *   setGroove: (on: boolean, bpm: number) => void,
 *   setScale: (scale: string) => void,
 *   setKey: (key: string) => void
 * }} ui
 *
 * @remarks
 *  - setStatus:更新 LIVE 指示 / 提示文案(idle、模型載入中、運作中、未偵測到手、錯誤)。
 *  - showStart:顯示「開始」覆蓋(點擊觸發 onStart → app 解鎖 audio + 啟相機;設計 §8)。
 *  - showError:顯示友善錯誤卡片 + 重試(無鏡頭/拒絕授權/模型載入失敗;設計 §8)。
 *  - setGroove/setScale/setKey:外部狀態回灌 UI(讓控制列顯示與實際狀態同步)。
 */
export function createUI({ root, onChange }) {
  const { topbar, hint, overlay } = root;

  // ── 內部 UI 狀態(僅供回灌顯示;真相在 musicEngine / audioEngine)──
  let grooveOn = GROOVE_DEFAULT_ON;
  let bpm = BPM;

  // 控制項元素 ref(由 buildTopbar 填入,setStatus/setGroove… 回灌時用)
  /** @type {HTMLElement} */ let liveBadge;
  /** @type {HTMLSelectElement} */ let scaleSelect;
  /** @type {HTMLSelectElement} */ let keySelect;
  /** @type {HTMLElement} */ let groovePill;
  /** @type {HTMLInputElement} */ let grooveToggle;
  /** @type {HTMLInputElement} */ let bpmInput;
  /** @type {HTMLElement} */ let bpmValue;
  /** @type {HTMLSelectElement} */ let instSelect;

  // ── DOM helper:極簡 createElement 包裝(屬性 + 子節點)──
  function h(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v != null) {
        node.setAttribute(k, v);
      }
    }
    for (const c of [].concat(children)) {
      if (c != null) node.append(c);
    }
    return node;
  }

  /** 玻璃 pill 包一個 <select>(下拉),用原生 select 維持可及性與零彈窗狀態機。 */
  function makeSelectPill(labelText, options, onSelect, selectRefSetter) {
    const select = h('select', { class: 'pill-select', 'aria-label': labelText });
    for (const opt of options) {
      select.append(h('option', { value: opt.value, text: opt.label }));
    }
    select.addEventListener('change', () => onSelect(select.value));
    selectRefSetter(select);
    return h('label', { class: 'pill pill-control' }, [
      h('span', { class: 'k', text: labelText }),
      select,
      h('span', { class: 'chev', text: '▾', 'aria-hidden': 'true' }),
    ]);
  }

  // ── 頂部玻璃控制列(設計 §6)──
  function buildTopbar() {
    // 品牌 + LIVE 指示
    liveBadge = h('span', { class: 'live is-idle' }, [
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      'LIVE',
    ]);
    const brand = h('div', { class: 'brand' }, [
      liveBadge,
      h('span', { class: 'nm', html: 'Hand<span>Sing</span>' }),
    ]);

    // 音階 preset 下拉(選項讀 config.SCALE_PRESETS,不硬寫第二份清單)
    const scaleOptions = Object.keys(SCALE_PRESETS).map((id) => ({
      value: id,
      label: SCALE_LABELS[id] || id,
    }));
    const scalePill = makeSelectPill('音階', scaleOptions, (v) => onChange({ type: 'scale', scale: v }), (el) => {
      scaleSelect = el;
    });

    // 調 下拉(選項讀 config.KEY_OFFSETS)
    const keyOptions = Object.keys(KEY_OFFSETS).map((k) => ({ value: k, label: k }));
    const keyPill = makeSelectPill('調', keyOptions, (v) => onChange({ type: 'key', key: v }), (el) => {
      keySelect = el;
    });

    // 伴奏律動 toggle + BPM(設計 §3.4)
    grooveToggle = h('input', {
      type: 'checkbox',
      class: 'tg-input',
      'aria-label': '伴奏律動開關',
    });
    grooveToggle.checked = grooveOn;
    grooveToggle.addEventListener('change', () => {
      grooveOn = grooveToggle.checked;
      groovePill.classList.toggle('on', grooveOn);
      onChange({ type: 'groove', groove: grooveOn });
    });

    bpmInput = h('input', {
      type: 'range',
      class: 'bpm-range',
      min: String(BPM_MIN),
      max: String(BPM_MAX),
      step: '1',
      'aria-label': '伴奏 BPM',
    });
    bpmInput.value = String(bpm);
    bpmValue = h('span', { class: 'v', text: String(bpm) });
    bpmInput.addEventListener('input', () => {
      bpm = Number(bpmInput.value);
      bpmValue.textContent = String(bpm);
      onChange({ type: 'bpm', bpm });
    });

    groovePill = h('div', { class: 'pill pill-control groove' + (grooveOn ? ' on' : '') }, [
      h('span', { class: 'k', text: '伴奏律動' }),
      h('label', { class: 'tg' }, [grooveToggle, h('span', { class: 'tg-knob', 'aria-hidden': 'true' })]),
      bpmInput,
      bpmValue,
      h('span', { class: 'k', text: 'BPM' }),
    ]);

    // 音色 下拉(stretch,先預留;觸發 instrument 事件)
    const instOptions = INSTRUMENTS.map((i) => ({ value: i.id, label: i.label }));
    const instPill = makeSelectPill('音色', instOptions, (v) => onChange({ type: 'instrument', chordInst: v, melodyInst: v }), (el) => {
      instSelect = el;
    });

    const controls = h('div', { class: 'controls' }, [scalePill, keyPill, groovePill, instPill]);

    topbar.replaceChildren(brand, controls);
  }

  // ── 底部提示列(設計 §6)──
  function buildHint() {
    const statusChip = h('span', { class: 'hint-status', id: 'hint-status' }, [
      h('span', { class: 'hint-status-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'hint-status-text', text: STATUS_TEXT.idle }),
    ]);
    hint.replaceChildren(
      statusChip,
      h('span', { html: '👈 <b>左手</b>:指外圈一塊 = 換和弦' }),
      h('span', { html: '👉 <b>右手</b>:指到彩色音 = 彈那個音' }),
      h('span', { html: '✋ 手<b>離開琴鍵</b> = 安靜(換你唱)' }),
      h('span', { html: '🎤 <b>邊唱邊伴奏</b>' }),
    );
  }

  // ── 隱私聲明(設計 §7 Ops:相機畫面 100% 本地處理、絕不上傳)──
  function privacyNote() {
    return h('p', { class: 'privacy' }, [
      h('span', { class: 'privacy-icon', text: '🔒', 'aria-hidden': 'true' }),
      h('span', {
        html: '相機畫面 <b>100% 在你的裝置本地處理</b>，<b>絕不上傳</b>任何伺服器。',
      }),
    ]);
  }

  // ── 覆蓋層卡片 helper(開始 / 錯誤共用外框)──
  function showCard(node) {
    overlay.replaceChildren(node);
    overlay.classList.add('is-visible');
    overlay.setAttribute('aria-hidden', 'false');
  }

  function setStatus(status, detail) {
    // LIVE 徽章:僅 'live' 點亮(脈動);其餘呈待機色
    if (liveBadge) liveBadge.classList.toggle('is-idle', status !== 'live');

    // 底部運作狀態 chip
    const chip = hint.querySelector('#hint-status');
    if (chip) {
      chip.classList.remove('s-idle', 's-loading', 's-live', 's-no-hand', 's-error');
      chip.classList.add('s-' + status);
      const text = chip.querySelector('.hint-status-text');
      if (text) text.textContent = detail || STATUS_TEXT[status] || status;
    }
  }

  function showStart(onStart) {
    const startBtn = h('button', { class: 'btn-primary', type: 'button', text: '開始' });
    startBtn.addEventListener('click', () => {
      onChange({ type: 'start' });
      onStart();
    });

    const card = h('div', { class: 'card card-start', role: 'dialog', 'aria-label': 'HandSing 開始' }, [
      h('div', { class: 'card-glow', 'aria-hidden': 'true' }),
      h('h1', { class: 'card-title', html: 'Hand<span>Sing</span>' }),
      h('p', { class: 'card-lead', text: '左手換和弦 · 右手指旋律 · 邊唱邊即興伴奏' }),
      h('ol', { class: 'steps' }, [
        h('li', { html: '<b>1</b> 允許使用鏡頭' }),
        h('li', { html: '<b>2</b> 舉手到畫面中、看到游標' }),
        h('li', { html: '<b>3</b> 右手指到彩色琴鍵,彈出旋律' }),
      ]),
      startBtn,
      privacyNote(),
    ]);
    showCard(card);
  }

  function showError(message, onRetry) {
    // 點亮非 live 狀態,並讓底部 chip 反映錯誤
    setStatus('error', message);

    const retryBtn = h('button', { class: 'btn-primary', type: 'button', text: '重試' });
    retryBtn.addEventListener('click', () => onRetry());

    const card = h('div', { class: 'card card-error', role: 'alertdialog', 'aria-label': '發生錯誤' }, [
      h('div', { class: 'card-icon', text: '⚠️', 'aria-hidden': 'true' }),
      h('h2', { class: 'card-title', text: '無法啟動' }),
      h('p', { class: 'card-lead', text: message }),
      retryBtn,
      privacyNote(),
    ]);
    showCard(card);
  }

  function hideOverlay() {
    overlay.classList.remove('is-visible');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.replaceChildren();
  }

  function setGroove(on, bpmValueIn) {
    grooveOn = on;
    bpm = bpmValueIn;
    if (grooveToggle) grooveToggle.checked = on;
    if (groovePill) groovePill.classList.toggle('on', on);
    if (bpmInput) bpmInput.value = String(bpmValueIn);
    if (bpmValue) bpmValue.textContent = String(bpmValueIn);
  }

  function setScale(scale) {
    if (scaleSelect) scaleSelect.value = scale;
  }

  function setKey(key) {
    if (keySelect) keySelect.value = key;
  }

  // ── 初始化:建好控制列 + 提示列(覆蓋層由 showStart/showError 觸發)──
  buildTopbar();
  buildHint();
  overlay.setAttribute('aria-hidden', 'true');

  return {
    setStatus,
    showStart,
    showError,
    hideOverlay,
    setGroove,
    setScale,
    setKey,
  };
}
