# 🙌 jazz-hands

> 用手在空中演奏音樂的鏡頭手勢遊戲。左手控和弦、右手控音階,邊唱邊比劃伴奏 —— 零樂理門檻,怎麼指都好聽。

鏡頭把你照進畫面,左右各疊一個發光圓盤。系統**只追蹤每隻手的食指尖一個點**(不辨識手勢、不做骨架分類),看它指到哪一塊扇形,就發出那一塊的聲音。

- **左盤(洋紅)= 和弦**:食指指到某塊 → 該和弦持續鋪底;移到中心 → 停。
- **右盤(青綠)= 旋律**:從中心**指出去** → 彈那個音;回中心 → 安靜(換你唱)。
- **自動伴奏律動**:打開後,左手選的和弦會自動刷弦/分解,像有人幫你伴奏。

## 玩法

用桌機 / 筆電的 **Chrome** 開啟 → 允許使用鏡頭 → 點「開始」→ 舉起雙手,看著食指尖的游標,左手換和弦、右手指出旋律,開始邊唱邊伴奏。

> 🔒 **隱私**:相機畫面 100% 在你的裝置本地處理,絕不上傳任何伺服器。

## 技術棧

| 範圍 | 技術 |
|---|---|
| 手部追蹤 | [MediaPipe Hands](https://developers.google.com/mediapipe)(只取食指尖 landmark) |
| 音訊合成 | [Tone.js](https://tonejs.github.io/) |
| 繪圖 | Canvas 2D(疊在相機畫面上) |
| 建置 | [Vite](https://vitejs.dev/) · 純前端、無後端 |
| 測試 | [Vitest](https://vitest.dev/)(純邏輯模組:幾何 / 座標映射 / 樂理) |

## 本地開發

```bash
npm install
npm run dev      # 開發伺服器(http://localhost:5173)
npm test         # 單元測試
npm run build    # 產出 dist/
```

## 架構

純前端,模組各司其職、純邏輯與 I/O 分離(`coordinateMapper` / `musicEngine` / `geometry` 為無 DOM 純函數,可單元測試):

```
camera → handTracking(MediaPipe)→ coordinateMapper(平滑+死區+遲滯)
       → musicEngine(塊→和弦/音階)→ audioEngine(Tone.js)+ renderer(Canvas)
```

完整設計文件見 [`docs/superpowers/specs/`](docs/superpowers/specs/)。
