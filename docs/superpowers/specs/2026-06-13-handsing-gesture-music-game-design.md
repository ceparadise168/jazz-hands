# HandSing — 鏡頭手勢音樂遊戲 · 原型概念設計

- **日期**:2026-06-13
- **狀態**:設計已 approved(使用者 LGTM),作為原型實作的 single source of truth
- **Codename**:`HandSing`(暫定,可改)
- **作者**:Eric × Claude (brainstorming session)

---

## 0 · 決策摘要(對話中已確認)

| 決策 | 選擇 | 備註 |
|---|---|---|
| 互動骨幹 | 鏡頭 + **食指尖單點**追蹤,落在扇形圓盤的哪一塊 | **不辨識手勢/骨架**(使用者過去踩雷),只讀一個座標點 |
| 產品定位 | **A · 音樂玩具 / 表演工具** | 鎖調、怎麼指都好聽、系統幫修飾、零學習、即時成就感 |
| 左手 | 洋紅圓盤 = **和弦** | 進入塊即換、持續鋪底 |
| 右手 | 青綠圓盤 = **音階(旋律)** | 中心休息區、指出去才響 |
| 視覺風格 | **霓虹電音 Neon Arcade** | 深底 + 螢光發光,對比最強、游標最清楚 |
| 音階預設 | **五聲音階 Pentatonic** | 無半音衝突,亂指都和諧;可切 preset/換調 |
| 自動伴奏 | **律動開關(預設關,納入 MVP)** | 開→自動 strum/分解和弦;關→乾淨長音 |
| 平台 | 桌機/筆電 **Chrome**(webcam) | 手機後續 |
| 手追蹤 | **MediaPipe Hands** | 瀏覽器內、免後端,取 index fingertip(landmark 8) |
| 音訊 | **Tone.js** | 合成/取樣/效果/節奏排程一站 |
| 前端 | **Vite + 原生模組 JS**,Canvas 2D | 原型輕,無框架負擔 |
| 範圍 | 純前端單頁、無後端、無帳號、無存檔 | 錄音/分享為 stretch |

---

## 1 · 願景與定位

一句話:**鏡頭把你照進畫面,左手在洋紅盤換和弦、右手在青綠盤指出旋律,邊唱邊用雙手即興伴奏 —— 零樂理、怎麼指都好聽。**

定位是「音樂**玩具 / 表演工具**」,不是「精確數位樂器」。所有設計取捨都服從一個北極星:**第一次用就有成就感、邊唱邊伴奏很爽、不會出錯音**。因此系統主動把使用者「鎖在好聽的範圍內」(鎖調 + 五聲 + 自動修飾),用體驗換取一部分精確控制 —— 這正是「靠手位置」這種有限精度介面的最佳打法。

---

## 2 · 核心互動規格

### 2.1 鏡頭與分盤(關鍵決策)
- 畫面**水平鏡像**顯示(像照鏡子,最直覺)。
- **以「螢幕左右位置」分盤**:畫面左半的手 → 控左盤(和弦);右半 → 控右盤(旋律)。
- **刻意用位置、不靠 MediaPipe 的 handedness 標籤**:鏡像 + 雙手交叉時 handedness 容易誤判;用螢幕位置 robust,且鏡像下「使用者左手自然出現在畫面左側」剛好對上「左手控和弦」的直覺。
- 同一半若偵測到多隻手指,取**最靠近該盤圓心**的食指尖。

### 2.2 觸發狀態機(兩盤底層統一、行為有別)

每個盤是一個獨立狀態機,輸入為「該手食指尖座標」,狀態:

```
REST(在中心休息區內 / 未偵測到手)  ──指尖移出死區到第 k 塊──▶  ACTIVE(k)
ACTIVE(k)  ──指尖移回死區 / 手消失──▶  REST
ACTIVE(k)  ──指尖跨越邊界到第 j 塊(超過 hysteresis margin)──▶  ACTIVE(j)
```

**左盤(和弦)行為**:
- 進入 `ACTIVE(k)` → 觸發和弦 k,**持續鋪底(sustain)**。
- `ACTIVE(k)→ACTIVE(j)` → 平順換成和弦 j(release 舊、attack 新,短 crossfade,像過門)。
- 回 `REST` → 停伴奏(release)。
- 自動伴奏開啟時:`ACTIVE(k)` 期間,Tone.Transport 依 BPM 對和弦 k 反覆 strum/分解;`REST` 時停。

**右盤(旋律)行為**:
- `REST` = 靜音(留白給人聲,鼓勵用中心斷句)。
- 進入 `ACTIVE(k)` → 音 k **attack + sustain**。
- `ACTIVE(k)→ACTIVE(j)` → 換音(release 舊、attack 新)。
- 回 `REST` → release(靜音)。

### 2.3 防誤觸三件套(體感命脈)
1. **座標平滑**:對食指尖座標套 **One-Euro filter**(建議起始 `mincutoff≈1.2, beta≈0.02`,實測微調),抖動小、快速移動不拖。
2. **邊界遲滯(hysteresis)**:從第 k 塊要換到相鄰塊,指尖須越過邊界**再多 ~6–8°**(角度 margin)才換,消除邊界顫動亂跳。
3. **中心死區**:休息區半徑 ≈ 盤外徑的 **35%**(= donut 內徑),夠大才容易「回中心」。

### 2.4 延遲預算
`相機幀 → 偵測 → 映射 → 發聲/繪製` 全鏈 **< ~100ms**,否則跟不上手、體感崩。偵測在 worker 或用 MediaPipe 的 GPU delegate;繪製與音訊走 rAF / Tone scheduling。

---

## 3 · 樂理映射(預設 C 大調)

### 3.1 右盤 · 五聲音階(8 塊)
- 由起始塊**順時針音高遞增**,跨約 1.6 八度:
  `C4 D4 E4 G4 A4 C5 D5 E5` → MIDI `[60, 62, 64, 67, 69, 72, 74, 76]`
- 五聲(Major Pentatonic)無 4 度/7 度半音衝突 → 任意組合都和諧。

### 3.2 左盤 · 和弦(8 塊)
C 大調好用和弦,四大金剛分散擺放好按:

| 塊 | 和弦 | 音(MIDI,voicing 由 audioEngine 收攏到中央八度) |
|---|---|---|
| 0 | C | 60 64 67 |
| 1 | G | 55 59 62 |
| 2 | Am | 57 60 64 |
| 3 | Em | 52 55 59 |
| 4 | F | 53 57 60 |
| 5 | Dm | 50 53 57 |
| 6 | G7 | 55 59 62 65 |
| 7 | Fmaj7 | 53 57 60 64 |

### 3.3 Preset 與調(stretch,但資料結構先預留)
- Scale presets:`pentatonic`(預設) / `major` / `minor` / `blues`。
- Key:`C`(預設) / `G` / `D` / `F` / `A` …(以半音 transpose 整體位移)。
- musicEngine 用 **scale degree → 音高** 的抽象,換 preset/key 只換對照表,不動其他模組。

### 3.4 自動伴奏律動
- toggle,**預設關**。BPM 預設 92。
- 開啟:`Tone.Transport` 啟動,依當前左盤和弦,用節奏型反覆彈奏。
- MVP 節奏型:**分解和弦 / 簡單刷弦**(八分音符 pattern);節奏型可選為 stretch。

---

## 4 · 系統架構(純前端 · 8 模組)

### 4.1 模組職責 + 介面契約

> 原則:`coordinateMapper` 與 `musicEngine` 是**純邏輯**(無 DOM / 無副作用),可單元測試。其餘為 I/O 邊界。介面契約如下(概念簽名,實作可調整命名但須維持邊界):

```text
camera.js
  createCamera({ video, mirror }) -> { start(): Promise<void>, stop(), stream }

handTracking.js   (依賴 MediaPipe Hands)
  createHandTracker({ video, onResults }) -> { start(): Promise<void>, stop() }
  // onResults(frame) 回傳 normalized 座標(0..1):
  //   { hands: [ { indexTip:{x,y}, handedness, ...landmarks }, ... ] }

coordinateMapper.js   (純邏輯)
  createMapper({ disks }) -> mapper
  // disks: { L:{cx,cy,rIn,rOut,slots:8}, R:{...} }  (像素座標)
  mapper.update(tipsNormalized, viewport) -> {
    L: { state:'REST'|'ACTIVE', zone:0..7|null, changed:boolean },
    R: { state:'REST'|'ACTIVE', zone:0..7|null, changed:boolean }
  }
  // 內含 One-Euro 平滑、角度→塊、死區、hysteresis

musicEngine.js   (純邏輯)
  createMusicEngine({ key:'C', scale:'pentatonic' }) -> engine
  engine.chordForSlot(k) -> { name, midi:number[] }
  engine.noteForSlot(k)  -> { name, midi:number }
  engine.setKey(k); engine.setScale(s)

audioEngine.js   (依賴 Tone.js)
  createAudioEngine() -> {
    unlock(): Promise<void>,                 // 使用者手勢後啟動 AudioContext
    setChord(midi[]|null),                    // 左盤:null=停
    setMelodyNote(midi|null),                 // 右盤:null=release
    setGroove(on:boolean, bpm:number),
    setInstrument(chordInst, melodyInst)
  }

renderer.js   (Canvas 2D,疊在 video 上)
  createRenderer({ canvas, disks }) -> {
    draw(state)  // state: { L:{zone,active,tip}, R:{...}, present }
  }

ui.js
  createUI({ root, onChange }) -> { setStatus(...), ... }
  // 控制:scale preset / key / groove toggle+bpm / instrument / 開始按鈕 / 提示

app.js
  // requestAnimationFrame 主迴圈:
  // camera ready → handTracking.onResults 緩存最新 tips
  // 每幀: mapper.update → diff → musicEngine 查表 → audioEngine 發聲 + renderer.draw
```

### 4.2 檔案結構
```
my-go/
  index.html
  package.json
  vite.config.js
  src/
    main.js            # 入口,組裝 app
    app.js             # 主迴圈與串接
    camera.js
    handTracking.js
    coordinateMapper.js
    musicEngine.js
    audioEngine.js
    renderer.js
    ui.js
    geometry.js        # 盤幾何 / 極座標 / 扇形命中(共用純函數)
    config.js          # 參數常數(死區比例、hysteresis、One-Euro、BPM、配色)
    styles.css
  test/
    coordinateMapper.test.js
    musicEngine.test.js
    geometry.test.js
```

---

## 5 · 資料流(每 frame)

```
video frame
  → handTracking (MediaPipe) → { hands: [{indexTip, handedness}] }   (非同步,緩存最新)
  → [rAF] coordinateMapper.update(tips) → { L:{zone,changed}, R:{zone,changed} }
  → diff vs 上一幀
      → musicEngine.chordForSlot / noteForSlot
      → audioEngine.setChord / setMelodyNote / setGroove
      → renderer.draw(視覺回饋:高亮塊、游標、休息區、發光、發聲氣泡)
```

---

## 6 · UI / 視覺規格(霓虹電音)

- 全螢幕:相機畫面(鏡像)鋪底 + 暗角 vignette + 細微 scanline。
- 左盤(和弦)洋紅色系發光 donut、右盤(旋律)青綠色系發光 donut;命中塊高亮 + glow;扇形標籤(和弦名 / 唱名)。
- 每盤中心:**休息區**(虛線圈 + 「休息區」字),hub 標 `CHORDS` / `MELODY`。
- **手游標**:白色雙環 + 中心點;畫一條「從中心指出」的虛線軌跡。
- **發聲氣泡**:盤上方顯示當前和弦 / 音名。
- **頂部玻璃控制列**:LIVE 指示 / 名稱 / 音階 preset / 調 / 伴奏律動 toggle + BPM / 音色。
- **底部提示列**:左手換和弦 · 右手指出彈旋律 · 回中心安靜 · 邊唱邊伴奏。
- 配色(`config.js`):背景 `#06080f`、和弦 `#ff5fa2`、旋律 `#27e0c8`、強調 `#ffc24b`。
- 參考 mockup:`.superpowers/brainstorm/.../prototype-mockup.html`。

---

## 7 · 5 切面設計檢視(design pass)

- **Product**:讓不會樂器的人即興自彈自唱、零學習即時爽。差異 = 鏡頭手勢 + 鎖調 + 雙盤分工。留存/新奇感退燒風險,原型不解(原型目的是驗證「好不好玩」)。
- **Ops**:純前端 + CDN 載模型 + 靜態託管(Vercel/Netlify/GitHub Pages),維運近零。風險 = MediaPipe CDN 可用性與模型首載大小(需 loading 態)。**隱私:相機畫面 100% 本地處理、絕不上傳 —— 必須在 UI 明講以建立信任。**
- **UX**:核心張力 = 位置精度有限 vs 要好聽 → 靠鎖調 / 五聲 / 中心休息 / 遲滯化解。Onboarding 三步:授權鏡頭 → 舉手看到游標 → 試指一下。跟手與低延遲是命脈。鏡像最直覺。
- **Architecture**:tracking/mapping/music/audio/render 邊界乾淨;`coordinateMapper`、`musicEngine`、`geometry` 純函數可單元測試;狀態最小、單一 rAF 迴圈。風險 = 每幀偵測 + 繪製的效能(需量 FPS)。
- **Business**:原型只驗「好不好玩、想不想分享」。變現遠期(音色包 / 去浮水印 / 教育版),現在不碰。護城河弱(易複製)→ 靠體驗打磨與內容。

> **原型階段刻意後置(標記,非遺漏)**:深度 a11y(本質依賴視覺 + 肢體,挑戰大)、深效能優化、法遵、資安強化 —— 第一個真實 / 付費用戶後必補。

---

## 8 · 錯誤處理

| 情境 | 處理 |
|---|---|
| 無鏡頭 / 拒絕授權 | 友善卡片說明 + 重試按鈕 |
| MediaPipe 模型載入失敗 | 提示 + retry,標示可能為網路/CDN |
| 偵測不到手 | 盤呈 idle 態 + 「把手舉到鏡頭前」 |
| AudioContext 未解鎖 | 「開始」按鈕觸發 `audioEngine.unlock()` |
| FPS 過低 | 降低偵測解析度 / 偵測頻率(每 2 幀偵測一次) |
| 換音爆音 | envelope 平滑 attack/release + 短 crossfade |

---

## 9 · 測試策略

- **TDD 核心純邏輯**(先測後寫):
  - `geometry`:點 → 極座標 → 扇形塊命中、死區判定。
  - `coordinateMapper`:座標序列 → 預期 zone / changed;hysteresis(邊界來回不亂跳);死區進出。
  - `musicEngine`:slot + key + scale → 預期 MIDI;換 preset/key 正確 transpose。
- **I/O 模組**(camera/audio/render/handTracking):手動測 + 必要時 mock(如以假資料餵 mapper→render 管線)。
- **E2E**:Chrome `--use-fake-device-for-media-stream` 餵測試影片驗證「載入無 error、UI 渲染、管線不崩」;真實手勢體感由使用者用真鏡頭驗收。

---

## 10 · 範圍

### MVP(核心可玩)
- 鏡頭 + 鏡像 + 雙手食指尖追蹤(MediaPipe)。
- 左盤和弦(C 大調 8 塊) / 右盤五聲(8 塊)。
- 統一觸發狀態機 + 防誤觸三件套。
- 霓虹視覺(雙盤 / 游標 / 休息區 / 高亮 / 發光 / 氣泡 / 控制列 / 提示)。
- Tone.js 音訊(和弦 pad + 旋律 lead,envelope)。
- 「開始」按鈕(解鎖 audio + 請求授權) + idle / 錯誤提示。
- **自動伴奏律動開關**(使用者指定納入)。

### Stretch(資料結構預留、可後做)
- Scale preset 切換(大調 / 小調 / 藍調) + 換調。
- 音色切換、節奏型選擇。
- 錄音 / 分享 / 匯出。
- 節拍器 / 節奏視覺、校準精靈。

---

## 11 · 實作順序(build sequence,供 workflow 編排)

1. **Scaffold**:`package.json`(vite + tone + @mediapipe/hands + vitest)、`vite.config.js`、`index.html`、`src/` 各檔 stub + 介面契約 + `config.js` 常數、`styles.css`。
2. **純邏輯(TDD,可平行)**:`geometry` → `coordinateMapper` → `musicEngine`,各帶 vitest 單元測試。
3. **I/O 模組(可平行,依賴 scaffold 契約)**:`camera`、`handTracking`、`audioEngine`、`renderer`、`ui`。
4. **整合**:`app.js` + `main.js` 主迴圈串接;確保 `vite build` 過、dev server 起得來、無 console error;以 fake stream 驗管線。
5. **多專家審查(PDCA)**:樂理體驗 / 互動 UX / 前端架構效能 / 視覺設計 / code review 五個 lens 並行,產出 findings。
6. **修復 + Polish**:修確認問題,打磨視覺與手感細節(多輪)。
7. **驗收**:design-council 風格總驗 + 截圖,交付使用者真鏡頭驗收。

---

## 12 · 開放 / 可調項(實作中可決定,非阻塞)

- 和弦盤的具體選擇與排列(目前 C 大調 8 顆;可換成某首歌的進行)。
- 五聲音階跨度(目前 1.6 八度)。
- 自動伴奏節奏型的具體感覺(分解 / 刷弦 / Bossa…)。
- 產品名(`HandSing` 暫定)。
- 防誤觸三參數的實測微調值。
