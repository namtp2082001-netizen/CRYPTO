/**
 * CRYPTO SWING MASTER V9.2 - BOT.JS
 * ------------------------------------------------------------
 * Chuyển hóa 1:1 logic tính toán từ file HTML gốc (xu_huong.html):
 *   - EMA50 / EMA200, ATR(14) trên khung 4h
 *   - Hồi quy tuyến tính (regression) + Momentum ngắn hạn -> Xu hướng & Độ tin cậy
 *   - Kế hoạch DCA 3 Entry (Entry 1/2/3) kèm Stop-Loss / Take-Profit theo R:R
 *   - Khoá bớt Entry gần giá khi Downtrend đã xác nhận & mạnh
 * Không tự chế thêm chỉ báo nào ngoài phạm vi bản gốc (không có OI/Funding/CVD/Netflow
 * vì bản HTML gốc không tính các chỉ số này - muốn thêm cần tích hợp thêm nguồn dữ liệu,
 * ví dụ CoinGlass API).
 *
 * Chạy độc lập (Render/VPS/GitHub Actions dạng long-running service):
 *   node bot.js
 * Biến môi trường: xem file .env.example
 * ------------------------------------------------------------
 */

'use strict';

const http = require('http');

// ---------- CẤU HÌNH TỪ BIẾN MÔI TRƯỜNG ----------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const CAPITAL = parseFloat(process.env.CAPITAL || '1000');
const SCAN_INTERVAL_MINUTES = parseInt(process.env.SCAN_INTERVAL_MINUTES || '120', 10);
const MIN_CONFIDENCE = parseInt(process.env.MIN_CONFIDENCE || '32', 10);
const PORT = parseInt(process.env.PORT || '10000', 10);
const SYMBOLS = (process.env.SYMBOLS || 'SOLUSDT,BTCUSDT,ETHUSDT,BNBUSDT,LINKUSDT,SUIUSDT')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

// ---------- COINS_DATA: Y HỆT BẢN GỐC (KHÔNG ĐỔI THÔNG SỐ) ----------
// entryGaps: khoảng cách TỐI THIỂU (bội số ATR) Entry1->Entry2->Entry3
// trendThreshold: ngưỡng % thay đổi giá TỐI THIỂU để gắn nhãn UPTREND/DOWNTREND
// regressionLookback: số nến 4h dùng hồi quy dài hạn
// momentumLookback: số nến 4h dùng đo đà giá ngắn hạn
// momentumWeight: tỷ trọng tín hiệu momentum khi quyết định nhãn xu hướng
const COINS_DATA = {
  SOLUSDT: { name: 'SOLANA', icon: 'S', atrMultiplier: 2.0, tpFactor: 1.15, decimals: 2, entryGaps: [0.8, 2.0, 3.6], trendThreshold: 1.3, regressionLookback: 36, momentumLookback: 8, momentumWeight: 0.55 },
  BTCUSDT: { name: 'BITCOIN', icon: '₿', atrMultiplier: 1.2, tpFactor: 1.05, decimals: 1, entryGaps: [0.6, 1.5, 2.6], trendThreshold: 0.8, regressionLookback: 50, momentumLookback: 12, momentumWeight: 0.40 },
  ETHUSDT: { name: 'ETHEREUM', icon: 'Ξ', atrMultiplier: 1.5, tpFactor: 1.08, decimals: 2, entryGaps: [0.7, 1.8, 3.2], trendThreshold: 1.0, regressionLookback: 42, momentumLookback: 10, momentumWeight: 0.50 },
  BNBUSDT: { name: 'BNB CHAIN', icon: 'B', atrMultiplier: 1.5, tpFactor: 1.08, decimals: 2, entryGaps: [0.7, 1.8, 3.2], trendThreshold: 1.0, regressionLookback: 42, momentumLookback: 10, momentumWeight: 0.50 },
  LINKUSDT: { name: 'CHAINLINK', icon: 'L', atrMultiplier: 2.2, tpFactor: 1.18, decimals: 3, entryGaps: [0.9, 2.2, 4.0], trendThreshold: 1.5, regressionLookback: 34, momentumLookback: 8, momentumWeight: 0.55 },
  SUIUSDT: { name: 'SUI', icon: 'S', atrMultiplier: 2.0, tpFactor: 1.12, decimals: 4, entryGaps: [0.8, 2.1, 3.8], trendThreshold: 1.6, regressionLookback: 30, momentumLookback: 6, momentumWeight: 0.60 },
};

// ---------- HÀM TOÁN HỌC CORE (COPY NGUYÊN LOGIC TỪ HTML) ----------

function calculateEMA(data, period) {
  if (data.length < period) return data[data.length - 1];
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 0; i < period; i++) ema += data[i];
  ema = ema / period;
  for (let i = period; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
  return ema;
}

function calculateATR(highs, lows, closes, period) {
  if (highs.length < period) return 0;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  let sum = 0;
  for (let i = trs.length - period; i < trs.length; i++) sum += trs[i];
  return sum / period;
}

function linearRegression(y) {
  const n = y.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += y[i];
    sumXY += i * y[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX || 1;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const meanY = sumY / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * i;
    ssTot += Math.pow(y[i] - meanY, 2);
    ssRes += Math.pow(y[i] - pred, 2);
  }
  return { slope, intercept, r2: ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot) };
}

// ---------- DỰ BÁO XU HƯỚNG + ĐỘ TIN CẬY (thay cho generate7DayForecast, bỏ phần vẽ chart) ----------

function generateForecast(closes, currentPrice, atr, symbol) {
  const config = COINS_DATA[symbol];
  const lookback = config.regressionLookback || 60;
  const sample = closes.slice(-lookback);
  const reg = linearRegression(sample);
  const n = sample.length;
  const dailyStep = 24 / 4;

  const predictions = [];
  for (let d = 1; d <= 7; d++) {
    const idx = n + dailyStep * d;
    predictions.push(reg.intercept + reg.slope * idx);
  }

  const volFactor = Math.min(1, atr / Math.max(1, currentPrice));
  let confidence = Math.max(0, reg.r2 * (1 - volFactor * 0.5));
  if (isNaN(confidence)) confidence = 0;
  const confPercentNum = Math.round(confidence * 100);
  const regChangePct = ((predictions[6] - currentPrice) / currentPrice) * 100;

  // Momentum ngắn hạn (chống trễ)
  const momLookback = Math.min(closes.length - 1, config.momentumLookback || 10);
  const pastClose = closes[closes.length - 1 - momLookback];
  const momentumChangePct = pastClose ? ((currentPrice - pastClose) / pastClose) * 100 : 0;
  const momWeight = config.momentumWeight != null ? config.momentumWeight : 0.5;

  const changePct = momentumChangePct * momWeight + regChangePct * (1 - momWeight);

  // Ngưỡng xu hướng tự thích ứng theo ATR thực tế + sàn riêng từng coin
  const floorThreshold = config.trendThreshold || 1.2;
  const volBasedThreshold = (atr / Math.max(1e-9, currentPrice)) * 100 * 0.6;
  const trendThreshold = Math.max(floorThreshold, volBasedThreshold);

  let trendLabel = 'SIDEWAY';
  if (confPercentNum < 32) {
    trendLabel = 'NHIỄU (WEAK)';
  } else if (changePct > trendThreshold) {
    trendLabel = 'UPTREND';
  } else if (changePct < -trendThreshold) {
    trendLabel = 'DOWNTREND';
  }

  return { trendLabel, confPercentNum, changePct, trendThreshold, predictions };
}

// ---------- KẾ HOẠCH DCA 3 ENTRY (thay cho generatePlan, trả về dữ liệu thay vì render HTML) ----------

function enforceEntrySpacing(entries, atr, gaps) {
  const minGap12 = Math.max(0, gaps[1] - gaps[0]) * atr;
  const minGap23 = Math.max(0, gaps[2] - gaps[1]) * atr;
  if (entries[0].price - entries[1].price < minGap12) entries[1].price = entries[0].price - minGap12;
  if (entries[1].price - entries[2].price < minGap23) entries[2].price = entries[1].price - minGap23;
  return entries;
}

function generatePlan(price, e50, e200, atr, high50, symbol, trendInfo, capital) {
  const config = COINS_DATA[symbol];
  const gaps = config.entryGaps || [0.7, 1.8, 3.2];

  let entry1Price = e50;
  let entry2Price = e200;
  let entry3Price = e200 - Math.max(config.atrMultiplier, gaps[2]) * atr;

  let desc1 = 'EMA50', desc2 = 'EMA200', desc3 = 'Panic';
  const isDowntrendZone = price < e50 || price < e200;

  if (isDowntrendZone) {
    entry1Price = price - gaps[0] * atr;
    entry2Price = price - gaps[1] * atr;
    entry3Price = price - gaps[2] * atr;

    if (entry1Price >= price) entry1Price = price * 0.98;
    if (entry2Price >= entry1Price) entry2Price = entry1Price * 0.96;
    if (entry3Price >= entry2Price) entry3Price = entry2Price * 0.94;

    desc1 = 'Hỗ trợ 1';
    desc2 = 'Hỗ trợ 2';
    desc3 = 'Panic';
  }

  let entries = [
    { desc: desc1, price: entry1Price, weight: 0.3 },
    { desc: desc2, price: entry2Price, weight: 0.3 },
    { desc: desc3, price: entry3Price, weight: 0.4 },
  ].sort((a, b) => b.price - a.price);

  entries = enforceEntrySpacing(entries, atr, gaps);
  entries.forEach((e, idx) => { e.name = `Entry ${idx + 1} (${e.desc})`; });

  let disabledCount = 0;
  if (isDowntrendZone && trendInfo && trendInfo.trendLabel === 'DOWNTREND') {
    disabledCount = trendInfo.confPercentNum >= 45 ? 2 : 1;
  }
  entries.forEach((e, idx) => { e.disabled = idx < disabledCount; });

  const targetRR = 1.8;
  const results = entries.map((e) => {
    const isPanic = e.name.includes('Entry 3');
    let stopLoss = e.price - config.atrMultiplier * atr;
    if (stopLoss <= 0) stopLoss = Math.max(0, e.price * 0.85);

    const tpFromRR = e.price + (e.price - stopLoss) * targetRR;
    let finalTP = isDowntrendZone ? Math.max(tpFromRR, price * 1.03) : Math.max(tpFromRR, high50 * 0.99);

    const maxAllowedTP = e.price * config.tpFactor;
    if (finalTP > maxAllowedTP) finalTP = maxAllowedTP;

    return {
      name: e.name,
      price: e.price,
      weight: e.weight,
      capital: capital * e.weight,
      stopLoss: isPanic ? stopLoss : null,
      takeProfit: finalTP,
      disabled: e.disabled,
    };
  });

  return { entries: results, disabledCount, isDowntrendZone };
}

// ---------- LẤY DỮ LIỆU BINANCE + PHÂN TÍCH 1 COIN ----------

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} khi gọi ${url}`);
  return res.json();
}

async function analyzeCoin(symbol, capital) {
  const config = COINS_DATA[symbol];
  if (!config) throw new Error(`Không có cấu hình cho symbol ${symbol}`);

  const pData = await fetchJSON(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
  const currentPrice = parseFloat(pData.price);

  const kData = await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=4h&limit=300`);
  const closes = kData.map((d) => parseFloat(d[4]));
  const highs = kData.map((d) => parseFloat(d[2]));
  const lows = kData.map((d) => parseFloat(d[3]));

  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const atr = calculateATR(highs, lows, closes, 14);
  const high50 = Math.max(...highs.slice(-50));

  const trendInfo = generateForecast(closes, currentPrice, atr, symbol);
  const plan = generatePlan(currentPrice, ema50, ema200, atr, high50, symbol, trendInfo, capital);

  return { symbol, config, currentPrice, ema50, ema200, atr, trendInfo, plan };
}

// ---------- FORMAT TIN NHẮN TELEGRAM ----------

function fmt(num, decimals) {
  if (num === null || num === undefined || isNaN(num)) return '--';
  return Number(num).toFixed(decimals);
}

function trendEmoji(label) {
  if (label === 'UPTREND') return '🟢';
  if (label === 'DOWNTREND') return '🔴';
  if (label === 'NHIỄU (WEAK)') return '⚪';
  return '🟡';
}

function actionRecommendation(trendInfo) {
  const c = trendInfo.confPercentNum;
  if (c < 32) return 'Đứng ngoài quan sát, chưa đủ cơ sở để kết luận xu hướng.';
  if (trendInfo.trendLabel === 'UPTREND') {
    return c >= 70
      ? 'Xu hướng tăng RÕ RÀNG → có thể vào đủ 3 Entry (30/30/40%).'
      : 'Xu hướng tăng trung bình → cẩn trọng, ưu tiên Entry 2 & 3, hạn chế đuổi giá ở Entry 1.';
  }
  if (trendInfo.trendLabel === 'DOWNTREND') {
    return c >= 45
      ? 'Downtrend MẠNH & rõ ràng → tạm khoá 2 Entry gần giá, chỉ chờ Entry 3 (Panic) bắt đáy sâu.'
      : 'Downtrend đã xác nhận → tạm khoá Entry 1 (gần giá nhất) để tránh bắt dao rơi.';
  }
  return 'Đi ngang (SIDEWAY) → chưa có tín hiệu vào lệnh rõ ràng, tiếp tục theo dõi.';
}

function buildTelegramMessage(result) {
  const { symbol, config, currentPrice, trendInfo, plan } = result;
  const dec = config.decimals;

  const lines = [];
  lines.push(`${trendEmoji(trendInfo.trendLabel)} <b>${config.name} (${symbol})</b> — <b>${trendInfo.trendLabel}</b> (Độ tin cậy: ${trendInfo.confPercentNum}%)`);
  lines.push(`💰 Giá hiện tại: <b>${fmt(currentPrice, dec)}</b> USDT`);
  lines.push(`📐 Ngưỡng xu hướng (%thay đổi tối thiểu để xác nhận trend): ${trendInfo.trendThreshold.toFixed(2)}%`);
  lines.push('');
  lines.push('<b>Kế hoạch DCA (Entry / SL / TP):</b>');

  const rows = ['Setup           Giá         SL          TP'];
  plan.entries.forEach((e) => {
    const priceStr = fmt(e.price, dec).padEnd(11);
    const slStr = (e.stopLoss !== null ? fmt(e.stopLoss, dec) : '--').padEnd(11);
    const tpStr = e.disabled ? '--' : fmt(e.takeProfit, dec);
    const nameStr = (e.disabled ? `${e.name} · CHỜ` : e.name).padEnd(16);
    rows.push(`${nameStr}${priceStr}${slStr}${tpStr}`);
  });
  lines.push(`<pre>${rows.join('\n')}</pre>`);

  if (plan.disabledCount > 0) {
    lines.push(`⚠️ ${plan.disabledCount === 2 ? 'Downtrend mạnh — đã khoá 2 Entry gần giá, chỉ chờ Entry sâu nhất (Panic).' : 'Downtrend đã xác nhận — đã khoá Entry gần giá nhất để tránh mua đuổi.'}`);
  }

  lines.push('');
  lines.push(`🎯 <b>Khuyến nghị:</b> ${actionRecommendation(trendInfo)}`);
  lines.push(`⏱ Cập nhật: ${new Date().toLocaleString('vi-VN', { hour12: false })}`);

  return lines.join('\n');
}

// ---------- GỬI TELEGRAM ----------

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID — bỏ qua gửi Telegram.');
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gửi Telegram thất bại: HTTP ${res.status} - ${errText}`);
  }
}

// ---------- VÒNG QUÉT CHÍNH ----------

function nowStr() {
  return new Date().toLocaleString('vi-VN', { hour12: false });
}

async function runScanCycle() {
  console.log(`\n🔍 [${nowStr()}] Bắt đầu tiến trình quét v9.2 (Chu kỳ ${SCAN_INTERVAL_MINUTES} phút)...`);

  for (const symbol of SYMBOLS) {
    try {
      const result = await analyzeCoin(symbol, CAPITAL);
      const { trendInfo } = result;
      const isActionable = trendInfo.trendLabel === 'UPTREND' || trendInfo.trendLabel === 'DOWNTREND';

      if (!isActionable || trendInfo.confPercentNum < MIN_CONFIDENCE) {
        console.log(`ℹ️  ${symbol}: Đang ${trendInfo.trendLabel === 'SIDEWAY' || trendInfo.trendLabel.startsWith('NHIỄU') ? 'Sideway hoặc độ tin cậy chưa đủ' : 'độ tin cậy chưa đủ'} (${trendInfo.confPercentNum}%). Bỏ qua gửi tin.`);
        continue;
      }

      const message = buildTelegramMessage(result);
      await sendTelegramMessage(message);
      console.log(`✅ ${symbol}: Tín hiệu ${trendInfo.trendLabel} (${trendInfo.confPercentNum}%) — Đã gửi Telegram.`);
    } catch (err) {
      console.error(`❌ ${symbol}: Lỗi khi phân tích/gửi tin — ${err.message}`);
    }
    // Giãn nhẹ giữa các coin để tránh dội rate-limit của Binance/Telegram
    await new Promise((r) => setTimeout(r, 800));
  }

  console.log(`🏁 [${nowStr()}] Kết thúc chu kỳ quét. Lần quét kế tiếp sau ${SCAN_INTERVAL_MINUTES} phút.`);
}

// ---------- WEB SERVER TỐI THIỂU (giữ Render "Web Service" luôn sống) ----------

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Crypto Swing Signal Bot đang chạy.\n');
  })
  .listen(PORT, () => {
    console.log(`🌐 Web Server đã khởi chạy thành công trên cổng ${PORT}`);
  });

// ---------- KHỞI ĐỘNG ----------

runScanCycle();
setInterval(runScanCycle, SCAN_INTERVAL_MINUTES * 60 * 1000);
