/**
 * CRYPTO SWING MASTER V9.2 - BOT.JS
 * ------------------------------------------------------------
 * GIỮ NGUYÊN 100% LOGIC ENTRY / TP / TREND
 * Chỉ tối ưu phần KẾT NỐI:
 * - Timeout cho mọi HTTP request
 * - Retry + backoff khi Binance/Telegram lỗi tạm thời
 * - Tự động đổi Binance endpoint khi endpoint chính lỗi
 * - Không để scan bị chạy chồng nhau
 * - /ping, /scan, /health luôn trả response cực nhẹ cho Cron-job.org
 * - Hỗ trợ /scan?xxx và /scan/
 * - Không làm thay đổi công thức Entry / TP hiện tại
 * ------------------------------------------------------------
 */

'use strict';

const http = require('http');

// ---------- CẤU HÌNH TỪ BIẾN MÔI TRƯỜNG ----------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const CAPITAL = parseFloat(process.env.CAPITAL || '1000');
const MIN_CONFIDENCE = parseInt(process.env.MIN_CONFIDENCE || '32', 10);
const PORT = parseInt(process.env.PORT || '10000', 10);
const SYMBOLS = (process.env.SYMBOLS || 'SOLUSDT,BTCUSDT,ETHUSDT,BNBUSDT,LINKUSDT,SUIUSDT')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

// ---------- NETWORK CONFIG ----------
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const RETRY_BASE_MS = parseInt(process.env.RETRY_BASE_MS || '700', 10);

// Binance public API có nhiều hostname.
// Nếu api.binance.com lỗi tạm thời, bot sẽ tự thử endpoint khác.
const BINANCE_HOSTS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
];

let scanPromise = null;

// ---------- COINS_DATA ----------
const COINS_DATA = {
  SOLUSDT: { name: 'SOLANA', icon: 'S', atrMultiplier: 2.0, tpFactor: 1.15, decimals: 2, entryGaps: [0.8, 2.0, 3.6], trendThreshold: 1.3, regressionLookback: 36, momentumLookback: 8, momentumWeight: 0.55 },
  BTCUSDT: { name: 'BITCOIN', icon: '₿', atrMultiplier: 1.2, tpFactor: 1.05, decimals: 1, entryGaps: [0.6, 1.5, 2.6], trendThreshold: 0.8, regressionLookback: 50, momentumLookback: 12, momentumWeight: 0.40 },
  ETHUSDT: { name: 'ETHEREUM', icon: 'Ξ', atrMultiplier: 1.5, tpFactor: 1.08, decimals: 2, entryGaps: [0.7, 1.8, 3.2], trendThreshold: 1.0, regressionLookback: 42, momentumLookback: 10, momentumWeight: 0.50 },
  BNBUSDT: { name: 'BNB CHAIN', icon: 'B', atrMultiplier: 1.5, tpFactor: 1.08, decimals: 2, entryGaps: [0.7, 1.8, 3.2], trendThreshold: 1.0, regressionLookback: 42, momentumLookback: 10, momentumWeight: 0.50 },
  LINKUSDT: { name: 'CHAINLINK', icon: 'L', atrMultiplier: 2.2, tpFactor: 1.18, decimals: 3, entryGaps: [0.9, 2.2, 4.0], trendThreshold: 1.5, regressionLookback: 34, momentumLookback: 8, momentumWeight: 0.55 },
  SUIUSDT: { name: 'SUI', icon: 'S', atrMultiplier: 2.0, tpFactor: 1.12, decimals: 4, entryGaps: [0.8, 2.1, 3.8], trendThreshold: 1.6, regressionLookback: 30, momentumLookback: 6, momentumWeight: 0.60 },
};

// ---------- HÀM TOÁN HỌC CORE ----------

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
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
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

  return {
    slope,
    intercept,
    r2: ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot),
  };
}

// ---------- DỰ BÁO XU HƯỚNG + ĐỘ TIN CẬY ----------

function generateForecast(closes, currentPrice, atr, symbol) {
  const config = COINS_DATA[symbol] || {
    trendThreshold: 1.2,
    regressionLookback: 60,
    momentumLookback: 10,
    momentumWeight: 0.5,
  };

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

  const momLookback = Math.min(closes.length - 1, config.momentumLookback || 10);
  const pastClose = closes[closes.length - 1 - momLookback];
  const momentumChangePct = pastClose
    ? ((currentPrice - pastClose) / pastClose) * 100
    : 0;

  const momWeight = config.momentumWeight != null ? config.momentumWeight : 0.5;
  const changePct = momentumChangePct * momWeight + regChangePct * (1 - momWeight);

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

  return {
    trendLabel,
    confPercentNum,
    changePct,
    trendThreshold,
    predictions,
  };
}

// ---------- LOGIC ENTRY DẢI DỰ PHÒNG & GIÃN CÁCH ATR ----------
// GIỮ NGUYÊN LOGIC ENTRY HIỆN TẠI

function enforceEntrySpacing(entries, atr, gaps) {
  const minGap12 = Math.max(0, gaps[1] - gaps[0]) * atr;
  const minGap23 = Math.max(0, gaps[2] - gaps[1]) * atr;

  if (entries[0].price - entries[1].price < minGap12) {
    entries[1].price = entries[0].price - minGap12;
  }

  if (entries[1].price - entries[2].price < minGap23) {
    entries[2].price = entries[1].price - minGap23;
  }

  return entries;
}

function generatePlan(price, e50, e200, atr, high50, symbol, trendInfo, capital) {
  const config = COINS_DATA[symbol] || {
    atrMultiplier: 1.5,
    tpFactor: 1.1,
    decimals: 2,
    entryGaps: [0.7, 1.8, 3.2],
  };

  const gaps = config.entryGaps || [0.7, 1.8, 3.2];

  let entry1Price, entry2Price, entry3Price;
  let desc1, desc2, desc3;

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
  } else {
    entry1Price = price - gaps[0] * atr;
    entry2Price = Math.min(e50, price - gaps[1] * atr);
    entry3Price = Math.min(e200, price - gaps[2] * atr);

    desc1 = 'Pullback nhanh';
    desc2 = 'EMA50 / Pullback sâu';
    desc3 = 'EMA200 / Panic';
  }

  let entries = [
    { desc: desc1, price: entry1Price, weight: 0.3 },
    { desc: desc2, price: entry2Price, weight: 0.3 },
    { desc: desc3, price: entry3Price, weight: 0.4 },
  ].sort((a, b) => b.price - a.price);

  entries = enforceEntrySpacing(entries, atr, gaps);

  entries.forEach((e, idx) => {
    e.name = `Entry ${idx + 1} (${e.desc})`;
  });

  let disabledCount = 0;

  if (isDowntrendZone && trendInfo && trendInfo.trendLabel === 'DOWNTREND') {
    disabledCount = trendInfo.confPercentNum >= 45 ? 2 : 1;
  }

  entries.forEach((e, idx) => {
    e.disabled = idx < disabledCount;
  });

  const targetRR = 1.8;

  const results = entries.map((e) => {
    const isPanic = e.name.includes('Panic') || e.name.includes('Entry 3');

    let stopLoss = e.price - config.atrMultiplier * atr;
    if (stopLoss <= 0) stopLoss = Math.max(0, e.price * 0.85);

    const tpFromRR = e.price + (e.price - stopLoss) * targetRR;
    let finalTP;

    if (isDowntrendZone) {
      finalTP = Math.max(tpFromRR, price * 1.03);
    } else {
      finalTP = Math.max(tpFromRR, high50 * 0.99);
    }

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

// ---------- NETWORK LAYER ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Crypto-Swing-Bot/9.2',
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`TIMEOUT sau ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJSON(url, options = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options);

      if (res.ok) {
        return await res.json();
      }

      const body = await res.text().catch(() => '');

      if (!isRetryableStatus(res.status) || attempt === MAX_RETRIES) {
        throw new Error(`HTTP ${res.status} khi gọi ${url}${body ? ` - ${body.slice(0, 180)}` : ''}`);
      }

      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;

      if (attempt === MAX_RETRIES) break;
    }

    const wait = RETRY_BASE_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
    console.warn(`⚠️ Retry ${attempt}/${MAX_RETRIES - 1}: ${url} — ${lastError.message} — chờ ${wait}ms`);
    await sleep(wait);
  }

  throw lastError || new Error(`Không lấy được dữ liệu: ${url}`);
}

async function fetchBinanceJSON(path) {
  let lastError = null;

  for (const host of BINANCE_HOSTS) {
    const url = `${host}${path}`;

    try {
      const data = await fetchJSON(url);
      return data;
    } catch (err) {
      lastError = err;
      console.warn(`⚠️ Binance endpoint lỗi: ${host} — ${err.message}`);
    }
  }

  throw new Error(`Tất cả Binance endpoint đều lỗi. ${lastError ? lastError.message : ''}`);
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID — bỏ qua gửi Telegram.');
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  await fetchJSON(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
}

// ---------- LẤY DỮ LIỆU BINANCE + PHÂN TÍCH 1 COIN ----------

async function analyzeCoin(symbol, capital) {
  const config = COINS_DATA[symbol];

  if (!config) {
    throw new Error(`Không có cấu hình cho symbol ${symbol}`);
  }

  const [pData, kData] = await Promise.all([
    fetchBinanceJSON(`/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`),
    fetchBinanceJSON(`/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=4h&limit=300`),
  ]);

  const currentPrice = parseFloat(pData.price);

  if (!Number.isFinite(currentPrice)) {
    throw new Error(`Giá hiện tại ${symbol} không hợp lệ`);
  }

  if (!Array.isArray(kData) || kData.length < 200) {
    throw new Error(`Kline ${symbol} không đủ dữ liệu: ${Array.isArray(kData) ? kData.length : 0}`);
  }

  const closes = kData.map((d) => parseFloat(d[4]));
  const highs = kData.map((d) => parseFloat(d[2]));
  const lows = kData.map((d) => parseFloat(d[3]));

  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const atr = calculateATR(highs, lows, closes, 14);
  const high50 = Math.max(...highs.slice(-50));

  const trendInfo = generateForecast(closes, currentPrice, atr, symbol);
  const plan = generatePlan(
    currentPrice,
    ema50,
    ema200,
    atr,
    high50,
    symbol,
    trendInfo,
    capital
  );

  return {
    symbol,
    config,
    currentPrice,
    ema50,
    ema200,
    atr,
    trendInfo,
    plan,
  };
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

  if (c < 32) {
    return 'Đứng ngoài quan sát, chưa đủ cơ sở để kết luận xu hướng.';
  }

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

  lines.push(
    `${trendEmoji(trendInfo.trendLabel)} <b>${config.name} (${symbol})</b> — <b>${trendInfo.trendLabel}</b> (Độ tin cậy: ${trendInfo.confPercentNum}%)`
  );
  lines.push(`💰 Giá hiện tại: <b>${fmt(currentPrice, dec)}</b> USDT`);
  lines.push(`📐 Ngưỡng xu hướng (%thay đổi tối thiểu để xác nhận trend): ${trendInfo.trendThreshold.toFixed(2)}%`);
  lines.push('');
  lines.push('<b>📋 Kế hoạch DCA:</b>');

  plan.entries.forEach((e) => {
    const statusTag = e.disabled ? '  <i>· CHỜ</i>' : '';

    lines.push(`\n▫️ <b>${e.name}</b>${statusTag}`);
    lines.push(`    💵 Giá vào: <b>${fmt(e.price, dec)}</b>`);

    if (e.stopLoss !== null) {
      lines.push(`    🛑 Stop-Loss: ${fmt(e.stopLoss, dec)}`);
    }

    if (!e.disabled) {
      lines.push(`    🎯 Take-Profit: ${fmt(e.takeProfit, dec)}`);
    }
  });

  if (plan.disabledCount > 0) {
    lines.push('');
    lines.push(
      `⚠️ ${plan.disabledCount === 2
        ? 'Downtrend mạnh — đã khoá 2 Entry gần giá, chỉ chờ Entry sâu nhất (Panic).'
        : 'Downtrend đã xác nhận — đã khoá Entry gần giá nhất để tránh mua đuổi.'}`
    );
  }

  lines.push('');
  lines.push(`🎯 <b>Khuyến nghị:</b> ${actionRecommendation(trendInfo)}`);
  lines.push(
    `⏱ Cập nhật: ${new Date().toLocaleString('vi-VN', {
      hour12: false,
      timeZone: 'Asia/Ho_Chi_Minh',
    })}`
  );

  return lines.join('\n');
}

// ---------- TELEGRAM CONFIG ----------

async function verifyTelegramConfig() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️ Telegram chưa được cấu hình đầy đủ.');
    return;
  }

  try {
    const data = await fetchJSON(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`
    );

    if (data && data.ok) {
      console.log(`✅ Telegram OK — bot: @${data.result.username}`);
    } else {
      console.error('❌ Telegram getMe trả về lỗi.');
    }
  } catch (err) {
    console.error(`⚠️ Không kiểm tra được Telegram lúc startup: ${err.message}`);
  }
}

function nowStr() {
  return new Date().toLocaleString('vi-VN', {
    hour12: false,
    timeZone: 'Asia/Ho_Chi_Minh',
  });
}

// ---------- SCAN ----------

async function runScanCycle() {
  // Chống 2 scan chạy cùng lúc nếu Cron-job.org gửi request trùng nhau.
  if (scanPromise) {
    console.log(`ℹ️ [${nowStr()}] Scan đang chạy — bỏ qua lần kích hoạt trùng.`);
    return scanPromise;
  }

  scanPromise = (async () => {
    console.log(`\n🔍 [${nowStr()}] Bắt đầu tiến trình quét v9.2...`);

    let successCount = 0;
    let errorCount = 0;
    let signalCount = 0;

    for (const symbol of SYMBOLS) {
      try {
        const result = await analyzeCoin(symbol, CAPITAL);
        const { trendInfo } = result;

        const isActionable =
          trendInfo.trendLabel === 'UPTREND' ||
          trendInfo.trendLabel === 'DOWNTREND';

        if (!isActionable || trendInfo.confPercentNum < MIN_CONFIDENCE) {
          console.log(
            `ℹ️ ${symbol}: Đang Sideway hoặc độ tin cậy chưa đủ (${trendInfo.confPercentNum}%). Bỏ qua.`
          );
          successCount++;
          continue;
        }

        const message = buildTelegramMessage(result);

        await sendTelegramMessage(message);

        successCount++;
        signalCount++;

        console.log(
          `✅ ${symbol}: Tín hiệu ${trendInfo.trendLabel} (${trendInfo.confPercentNum}%) — Đã gửi Telegram.`
        );
      } catch (err) {
        errorCount++;
        console.error(`❌ ${symbol}: Lỗi khi phân tích — ${err.message}`);
      }

      await sleep(800);
    }

    console.log(
      `🏁 [${nowStr()}] Kết thúc scan — OK: ${successCount}, Lỗi: ${errorCount}, Tín hiệu gửi: ${signalCount}`
    );
  })();

  try {
    await scanPromise;
  } finally {
    scanPromise = null;
  }
}

// ---------- HTTP SERVER ----------

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'close',
  });
  res.end(text);
}

const server = http.createServer((req, res) => {
  let pathname = '/';

  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch (_) {
    pathname = '/';
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'HEAD') {
    return sendText(res, 200, 'OK');
  }

  // Phản hồi siêu nhẹ cho /ping, /health và các đường dẫn gốc
  if (pathname === '/' || pathname === '/ping' || pathname === '/health') {
    return sendText(res, 200, 'OK');
  }

  // Cron-job.org gọi endpoint này.
  // Trả về response cực kỳ gọn nhẹ (vài chữ) ngay lập tức để chống lỗi "output too large".
  if (pathname === '/scan' || pathname === '/scan/') {
    const alreadyRunning = Boolean(scanPromise);

    console.log(
      `\n🔔 [${nowStr()}] Nhận request /scan từ Cron/HTTP — ${alreadyRunning ? 'scan đang chạy' : 'bắt đầu scan'}`
    );

    if (!alreadyRunning) {
      runScanCycle().catch((err) => {
        console.error(`❌ Lỗi scan ngoài dự kiến: ${err.message}`);
      });
    }

    return sendText(
      res,
      200,
      alreadyRunning ? 'SCAN_IN_PROGRESS' : 'OK'
    );
  }

  return sendText(res, 200, 'OK');
});

server.on('error', (err) => {
  console.error(`❌ HTTP Server error: ${err.message}`);
});

server.keepAliveTimeout = 5000;
server.headersTimeout = 6000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web Server đã khởi chạy trên 0.0.0.0:${PORT}`);
  console.log(`🔗 Health: /ping`);
  console.log(`🔗 Scan:   /scan`);
  console.log(`⏱ Chế độ scan: CHỈ nhận lệnh từ Cron-job.org qua /scan`);
});

// ---------- STARTUP ----------

(async () => {
  // Render chỉ khởi động server và kiểm tra Telegram.
  // Scan định kỳ DUY NHẤT do Cron-job.org gọi /scan.
  await verifyTelegramConfig();
})();

// ---------- PROCESS ERROR HANDLING ----------

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});
