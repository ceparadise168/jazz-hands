/**
 * camera.js — 相機 I/O 邊界(設計 §4.1 / §2.1 / §7 / §8)。
 *
 * 職責:取得 webcam 串流並接到 <video>。**水平鏡像**(像照鏡子,設計 §2.1 最直覺)
 * 由顯示層 CSS(.cam-video { transform: scaleX(-1) })負責;此處只負責拿 stream,
 * 並依 `mirror` 旗標以 inline transform 校正/覆寫,讓 mirror:false 也能正確關閉鏡像。
 *
 * 隱私:相機畫面 100% 本地處理、絕不上傳(設計 §7 Ops)—— 本模組只開本機串流、
 * 不發任何網路請求。
 *
 * 錯誤處理(設計 §8:無鏡頭 / 拒絕授權 → 友善卡片 + 重試):start() 失敗時 throw 一個
 * 可辨識類型的 CameraError(帶 `code`),讓 UI 能據此分流文案,而非讓整個 app 崩掉。
 */

/**
 * 相機錯誤碼(可辨識類型;對應設計 §8 的錯誤情境分流)。
 * @readonly
 * @enum {string}
 */
export const CameraErrorCode = {
  /** 使用者拒絕授權(NotAllowedError / SecurityError / PermissionDeniedError)。 */
  PERMISSION_DENIED: 'permission-denied',
  /** 找不到相機裝置(NotFoundError / DevicesNotFoundError)。 */
  NO_DEVICE: 'no-device',
  /** 裝置存在但被其他程式佔用 / 讀取失敗(NotReadableError / TrackStartError)。 */
  DEVICE_IN_USE: 'device-in-use',
  /** 約束無法滿足(OverconstrainedError / ConstraintNotSatisfiedError)。 */
  CONSTRAINT: 'constraint',
  /** 瀏覽器不支援 getUserMedia(無 navigator.mediaDevices)。 */
  UNSUPPORTED: 'unsupported',
  /** 其他未分類錯誤。 */
  UNKNOWN: 'unknown',
};

/**
 * 可辨識的相機錯誤。`code` 取自 {@link CameraErrorCode},`cause` 保留原始 DOMException。
 * @extends Error
 */
export class CameraError extends Error {
  /**
   * @param {string} code {@link CameraErrorCode} 之一
   * @param {string} message 友善訊息(可直接給 UI 卡片)
   * @param {unknown} [cause] 原始錯誤(除錯用)
   */
  constructor(code, message, cause) {
    super(message);
    this.name = 'CameraError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * 把 getUserMedia 丟出的原生錯誤對應成可辨識的 {@link CameraError}。
 * 不同瀏覽器的 DOMException name 有歷史別名,一併涵蓋。
 * @param {unknown} err 原始錯誤
 * @returns {CameraError}
 */
function toCameraError(err) {
  const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError': // 舊版 Chrome 別名
      return new CameraError(
        CameraErrorCode.PERMISSION_DENIED,
        '相機授權被拒絕。請在瀏覽器網址列開啟相機權限後重試。',
        err,
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError': // 舊版別名
      return new CameraError(
        CameraErrorCode.NO_DEVICE,
        '找不到可用的相機。請接上 webcam 後重試。',
        err,
      );
    case 'NotReadableError':
    case 'TrackStartError': // 舊版別名
      return new CameraError(
        CameraErrorCode.DEVICE_IN_USE,
        '相機可能被其他程式佔用。請關閉其他使用相機的程式後重試。',
        err,
      );
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError': // 舊版別名
      return new CameraError(
        CameraErrorCode.CONSTRAINT,
        '相機無法滿足要求的設定。請改用其他相機或重試。',
        err,
      );
    default:
      return new CameraError(
        CameraErrorCode.UNKNOWN,
        '無法開啟相機,請重試。',
        err,
      );
  }
}

/**
 * 建立相機控制器。
 * @param {Object} opts
 * @param {HTMLVideoElement} opts.video 目標 <video> 元素
 * @param {boolean} [opts.mirror=true] 是否鏡像顯示(設計 §2.1,預設鏡像)
 * @returns {{
 *   start: () => Promise<void>,   // 請求授權 + 開串流 + video.play();失敗 throw CameraError(供 UI 顯示錯誤卡片)
 *   stop: () => void,             // 停止所有 track、釋放相機
 *   stream: MediaStream | null    // 目前串流(未啟動為 null)
 * }} camera
 *
 * @remarks viewport 尺寸與實際解析度由瀏覽器/約束決定;app/renderer 讀 video.videoWidth/Height。
 */
export function createCamera({ video, mirror = true }) {
  if (!video) {
    throw new Error('createCamera: 需要 video 元素');
  }

  /** @type {MediaStream | null} 目前持有的串流(未啟動為 null)。 */
  let stream = null;

  /**
   * 套用鏡像顯示。CSS 已在 .cam-video 預設 scaleX(-1);此處以 inline style 明確設定,
   * 確保 `mirror` 旗標為單一真實來源 —— mirror:false 時可正確覆寫關閉鏡像。
   */
  function applyMirror() {
    video.style.transform = mirror ? 'scaleX(-1)' : 'none';
  }

  /**
   * 請求 getUserMedia({ video:true })、掛到 video、await play()。
   * 失敗(拒絕授權 / 無裝置 / 裝置佔用 …)會 throw 可辨識的 {@link CameraError}。
   * 已啟動時為 idempotent:直接 return,不重複開串流。
   * @returns {Promise<void>}
   */
  async function start() {
    if (stream) return; // 已啟動:idempotent

    // 環境防呆:非安全內容(http)或舊瀏覽器無 mediaDevices.getUserMedia。
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new CameraError(
        CameraErrorCode.UNSUPPORTED,
        '此瀏覽器或環境不支援相機存取(需 HTTPS 或 localhost、且為支援的瀏覽器)。',
      );
    }

    let media;
    try {
      // 只取 video;不取 audio(避免不必要的麥克風授權)。
      // 偏好前鏡頭、給理想解析度作為提示(非強制,避免 OverconstrainedError)。
      media = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
    } catch (err) {
      throw toCameraError(err);
    }

    stream = media;
    applyMirror();
    video.srcObject = stream;

    try {
      // autoplay + muted + playsinline(見 index.html)通常可自動播放;
      // 仍顯式 await play() 以確保 video 真的開始(供 handTracking 逐幀讀圖)。
      await video.play();
    } catch (err) {
      // 播放失敗(極少見:如被瀏覽器策略擋)→ 清掉已開的串流避免相機指示燈卡亮,再上拋。
      stop();
      throw new CameraError(
        CameraErrorCode.UNKNOWN,
        '相機串流無法播放,請重試。',
        err,
      );
    }
  }

  /** 停止串流、釋放所有 track、清空 video.srcObject。可重複呼叫。 */
  function stop() {
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      stream = null;
    }
    // 即使無 stream 也清乾淨,確保相機指示燈熄滅、video 不殘留畫面。
    video.srcObject = null;
  }

  return {
    start,
    stop,
    get stream() {
      return stream;
    },
  };
}
