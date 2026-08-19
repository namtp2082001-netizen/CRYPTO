/**
 * CRYPTO SWING MASTER V9.3 - BOT.JS
 * ------------------------------------------------------------
 * Đã đồng bộ 100% logic tính Entry với Web Dashboard (xu_huong.html)
 * Đã tối ưu HTTP Server riêng cho Cron-job Ping (/ping -> OK)
 * Chỉ số Sức mạnh xu hướng vẫn được tính nội bộ, nhưng KHÔNG hiển thị trên Telegram
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

// ---------- COINS_DATA ----------
const COINS_DATA = {
  SOLUSDT: {
    name: 'SOLANA',
    icon: 'S',
    atrMultiplier: 2.0,
    tpFactor: 1.15,
    decimals: 2,
    entryGaps: [0.8, 2.0, 3.6],
    trendThreshold: 1.3,
    regressionLookback: 36,
    momentumLookback: 8,
    momentumWeight: 0.55
  },

  BTCUSDT: {
    name: 'BITCOIN',
    icon: '₿',
    atrMultiplier: 1.2,
    tpFactor: 1.05,
    decimals: 1,
    entryGaps: [0.6, 1.5, 2.6],
    trendThreshold: 0.8,
    regressionLookback: 50,
    momentumLookback: 12,
    momentumWeight: 0.40
  },

  ETHUSDT: {
    name: 'ETHEREUM',
    icon: 'Ξ',
    atrMultiplier: 1.5,
    tpFactor: 1.08,
    decimals: 2,
    entryGaps: [0.7, 1.8, 3.2],
    trendThreshold: 1.0,
    regressionLookback: 42,
    momentumLookback: 10,
    momentumWeight: 0.50
  },

  BNBUSDT: {
    name: 'BNB CHAIN',
    icon: 'B',
    atrMultiplier: 1.5,
    tpFactor: 1.08,
    decimals: 2,
    entryGaps: [0.7, 1.8, 3.2],
    trendThreshold: 1.0,
    regressionLookback: 42,
    momentumLookback: 10,
    momentumWeight: 0.50
  },

  LINKUSDT: {
    name: 'CHAINLINK',
    icon: 'L',
    atrMultiplier: 2.2,
    tpFactor: 1.18,
    decimals: 3,
    entryGaps: [0.9, 2.2, 4.0],
    trendThreshold: 1.5,
    regressionLookback: 34,
    momentumLookback: 8,
    momentumWeight: 0.55
  },

  SUIUSDT: {
    name: 'SUI',
    icon: 'S',
    atrMultiplier: 2.0,
    tpFactor: 1.12,
    decimals: 4,
    entryGaps: [0.8, 2.1, 3.8],
    trendThreshold: 1.6,
    regressionLookback: 30,
    momentumLookback: 6,
    momentumWeight: 0.60
  },
};

// ---------- HÀM TOÁN HỌC CORE ----------

function calculateEMA(data, period) {
  if (data.length < period) return data[data.length - 1];

  const k = 2 / (period + 1);
  let ema = data[0];

  for (let i = 0; i < period; i++) {
    ema += data[i];
  }

  ema = ema / period;

  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }

  return ema;
}

function calculateATR(highs, lows, closes, period) {
  if (highs.length < period) return 0;

  const trs = [];

  for (let i = 1; i < highs.length; i++) {
    trs.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
  }

  let sum = 0;

  for (let i = trs.length - period; i < trs.length; i++) {
    sum += trs[i];
  }

  return sum / period;
}

function linearRegression(y) {
  const n = y.length;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += y[i];
    sumXY += i * y[i];
    sumXX += i * i;
  }

  const denom = n * sumXX - sumX * sumX || 1;

  const slope =
    (n * sumXY - sumX * sumY) / denom;

  const intercept =
    (sumY - slope * sumX) / n;

  const meanY = sumY / n;

  let ssTot = 0;
  let ssRes = 0;

  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * i;

    ssTot += Math.pow(y[i] - meanY, 2);
    ssRes += Math.pow(y[i] - pred, 2);
  }

  return {
    slope,
    intercept,
    r2: ssTot === 0
      ? 0
      : Math.max(0, 1 - ssRes / ssTot)
  };
}

// ---------- DỰ BÁO XU HƯỚNG + ĐỘ TIN CẬY ----------

function generateForecast(closes, currentPrice, atr, symbol) {
  const config =
    COINS_DATA[symbol] || {
      trendThreshold: 1.2,
      regressionLookback: 60,
      momentumLookback: 10,
      momentumWeight: 0.5
    };

  const lookback = config.regressionLookback || 60;

  const sample = closes.slice(-lookback);

  const reg = linearRegression(sample);

  const n = sample.length;

  const dailyStep = 24 / 4;

  const predictions = [];

  for (let d = 1; d <= 7; d++) {
    const idx = n + dailyStep * d;

    predictions.push(
      reg.intercept + reg.slope * idx
    );
  }

  const volFactor =
    Math.min(
      1,
      atr / Math.max(1, currentPrice)
    );

  let confidence =
    Math.max(
      0,
      reg.r2 * (1 - volFactor * 0.5)
    );

  if (isNaN(confidence)) {
    confidence = 0;
  }

  const confPercentNum =
    Math.round(confidence * 100);

  const regChangePct =
    ((predictions[6] - currentPrice) / currentPrice) * 100;

  const momLookback =
    Math.min(
      closes.length - 1,
      config.momentumLookback || 10
    );

  const pastClose =
    closes[closes.length - 1 - momLookback];

  const momentumChangePct =
    pastClose
      ? ((currentPrice - pastClose) / pastClose) * 100
      : 0;

  const momWeight =
    config.momentumWeight != null
      ? config.momentumWeight
      : 0.5;

  // Vẫn tính Sức mạnh thực tế để xác định xu hướng,
  // nhưng không hiển thị chỉ số này trên Telegram.
  const changePct =
    momentumChangePct * momWeight +
    regChangePct * (1 - momWeight);

  const floorThreshold =
    config.trendThreshold || 1.2;

  const volBasedThreshold =
    (atr / Math.max(1e-9, currentPrice)) *
    100 *
    0.6;

  const trendThreshold =
    Math.max(
      floorThreshold,
      volBasedThreshold
    );

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
    predictions
  };
}

// ---------- LOGIC TÍNH ENTRY DẢI DỰ PHÒNG & GIÃN CÁCH ATR ----------

function enforceEntrySpacing(entries, atr, gaps) {
  const minGap12 =
    Math.max(0, gaps[1] - gaps[0]) * atr;

  const minGap23 =
    Math.max(0, gaps[2] - gaps[1]) * atr;

  if (
    entries[0].price - entries[1].price <
    minGap12
  ) {
    entries[1].price =
      entries[0].price - minGap12;
  }

  if (
    entries[1].price - entries[2].price <
    minGap23
  ) {
    entries[2].price =
      entries[1].price - minGap23;
  }

  return entries;
}

function generatePlan(
  price,
  e50,
  e200,
  atr,
  high50,
  symbol,
  trendInfo,
  capital
) {
  const config =
    COINS_DATA[symbol] || {
      atrMultiplier: 1.5,
      tpFactor: 1.1,
      decimals: 2,
      entryGaps: [0.7, 1.8, 3.2]
    };

  const gaps =
    config.entryGaps || [0.7, 1.8, 3.2];

  let entry1Price;
  let entry2Price;
  let entry3Price;

  let desc1;
  let desc2;
  let desc3;

  const isDowntrendZone =
    price < e50 || price < e200;

  if (isDowntrendZone) {
    entry1Price =
      price - gaps[0] * atr;

    entry2Price =
      price - gaps[1] * atr;

    entry3Price =
      price - gaps[2] * atr;

    if (entry1Price >= price) {
      entry1Price = price * 0.98;
    }

    if (entry2Price >= entry1Price) {
      entry2Price = entry1Price * 0.96;
    }

    if (entry3Price >= entry2Price) {
      entry3Price = entry2Price * 0.94;
    }

    desc1 = 'Hỗ trợ 1';
    desc2 = 'Hỗ trợ 2';
    desc3 = 'Panic';

  } else {

    entry1Price =
      price - gaps[0] * atr;

    entry2Price =
      Math.min(
        e50,
        price - gaps[1] * atr
      );

    entry3Price =
      Math.min(
        e200,
        price - gaps[2] * atr
      );

    desc1 = 'Pullback nhanh';
    desc2 = 'EMA50 / Pullback sâu';
    desc3 = 'EMA200 / Panic';
  }

  let entries = [
    {
      desc: desc1,
      price: entry1Price,
      weight: 0.3
    },
    {
      desc: desc2,
      price: entry2Price,
      weight: 0.3
    },
    {
      desc: desc3,
      price: entry3Price,
      weight: 0.4
    },
  ].sort((a, b) => b.price - a.price);

  entries =
    enforceEntrySpacing(
      entries,
      atr,
      gaps
    );

  entries.forEach((e, idx) => {
    e.name =
      `Entry ${idx + 1} (${e.desc})`;
  });

  let disabledCount = 0;

  if (
    isDowntrendZone &&
    trendInfo &&
    trendInfo.trendLabel === 'DOWNTREND'
  ) {
    disabledCount =
      trendInfo.confPercentNum >= 45
        ? 2
        : 1;
  }

  entries.forEach((e, idx) => {
    e.disabled =
      idx < disabledCount;
  });

  const targetRR = 1.8;

  const results =
    entries.map((e) => {

      const isPanic =
        e.name.includes('Panic') ||
        e.name.includes('Entry 3');

      let stopLoss =
        e.price -
        config.atrMultiplier * atr;

      if (stopLoss <= 0) {
        stopLoss =
          Math.max(
            0,
            e.price * 0.85
          );
      }

      const tpFromRR =
        e.price +
        (e.price - stopLoss) *
        targetRR;

      let finalTP;

      if (isDowntrendZone) {
        finalTP =
          Math.max(
            tpFromRR,
            price * 1.03
          );
      } else {
        finalTP =
          Math.max(
            tpFromRR,
            high50 * 0.99
          );
      }

      const maxAllowedTP =
        e.price * config.tpFactor;

      if (finalTP > maxAllowedTP) {
        finalTP = maxAllowedTP;
      }

      return {
        name: e.name,
        price: e.price,
        weight: e.weight,
        capital: capital * e.weight,
        stopLoss:
          isPanic
            ? stopLoss
            : null,
        takeProfit: finalTP,
        disabled: e.disabled,
      };
    });

  return {
    entries: results,
    disabledCount,
    isDowntrendZone
  };
}

// ---------- LẤY DỮ LIỆU THỊ TRƯỜNG + PHÂN TÍCH 1 COIN ----------

// Binance đang trả HTTP 418 cho IP Render hiện tại.
// HTTP 418 là IP BAN, không phải lỗi symbol hay lỗi công thức.
//
// Vì vậy bot sẽ:
// 1. Ưu tiên Binance khi IP không bị ban.
// 2. Nếu Binance trả 418/429 -> ghi nhận thời gian Retry-After.
// 3. Tự động chuyển sang CoinGecko để không làm hỏng vòng scan.
// 4. Khi hết thời gian ban, tự động thử Binance lại.
//
// Toàn bộ logic EMA / ATR / Forecast / Entry / Telegram phía dưới
// được giữ nguyên. Chỉ thay lớp lấy dữ liệu thị trường.

const BINANCE_BASE_URL = 'https://api.binance.com';
const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';

const COINGECKO_IDS = {
  SOLUSDT: 'solana',
  BTCUSDT: 'bitcoin',
  ETHUSDT: 'ethereum',
  BNBUSDT: 'binancecoin',
  LINKUSDT: 'chainlink',
  SUIUSDT: 'sui'
};

let binanceBlockedUntil = 0;

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Crypto-Swing-Master-V9.3',
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const retryAfterHeader =
      res.headers.get('retry-after');

    const retryAfterSeconds =
      retryAfterHeader
        ? parseInt(retryAfterHeader, 10)
        : 0;

    const err =
      new Error(
        `HTTP ${res.status} khi gọi ${url}`
      );

    err.status = res.status;

    err.retryAfterSeconds =
      Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds
        : 0;

    throw err;
  }

  return res.json();
}

async function fetchBinanceMarketData(symbol) {
  const now = Date.now();

  if (now < binanceBlockedUntil) {
    const remaining =
      Math.ceil(
        (binanceBlockedUntil - now) / 1000
      );

    throw Object.assign(
      new Error(
        `Binance đang bị giới hạn IP, còn khoảng ${remaining}s`
      ),
      {
        status: 418,
        retryAfterSeconds: remaining
      }
    );
  }

  try {

    const priceData =
      await fetchJSON(
        `${BINANCE_BASE_URL}/api/v3/ticker/price?symbol=${symbol}`
      );

    const klineData =
      await fetchJSON(
        `${BINANCE_BASE_URL}/api/v3/klines?symbol=${symbol}&interval=4h&limit=300`
      );

    if (
      !priceData ||
      !priceData.price
    ) {
      throw new Error(
        `Binance trả dữ liệu giá không hợp lệ cho ${symbol}`
      );
    }

    if (
      !Array.isArray(klineData) ||
      klineData.length < 200
    ) {
      throw new Error(
        `Binance trả không đủ dữ liệu nến cho ${symbol}`
      );
    }

    return {
      currentPrice:
        parseFloat(priceData.price),

      closes:
        klineData.map(
          (d) => parseFloat(d[4])
        ),

      highs:
        klineData.map(
          (d) => parseFloat(d[2])
        ),

      lows:
        klineData.map(
          (d) => parseFloat(d[3])
        ),

      source: 'BINANCE'
    };

  } catch (err) {

    if (
      err.status === 418 ||
      err.status === 429
    ) {

      const waitSeconds =
        Math.max(
          60,
          err.retryAfterSeconds || 300
        );

      binanceBlockedUntil =
        Date.now() +
        waitSeconds * 1000;

      console.warn(
        `⚠️ Binance HTTP ${err.status}: tạm ngưng gọi Binance ${waitSeconds}s và chuyển sang CoinGecko.`
      );
    }

    throw err;
  }
}

// ---------- GOM DỮ LIỆU COINGECKO THÀNH NẾN 4H ----------

function aggregateHourlyTo4H(prices) {
  const candles = [];

  if (!Array.isArray(prices)) {
    return candles;
  }

  const groups = new Map();

  for (const item of prices) {

    if (
      !Array.isArray(item) ||
      item.length < 2
    ) {
      continue;
    }

    const timestamp =
      Number(item[0]);

    const price =
      Number(item[1]);

    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(price)
    ) {
      continue;
    }

    const fourHourMs =
      4 * 60 * 60 * 1000;

    const bucket =
      Math.floor(
        timestamp / fourHourMs
      ) * fourHourMs;

    if (!groups.has(bucket)) {
      groups.set(bucket, []);
    }

    groups.get(bucket).push({
      timestamp,
      price
    });
  }

  const sortedBuckets =
    Array.from(
      groups.keys()
    ).sort(
      (a, b) => a - b
    );

  for (const bucket of sortedBuckets) {

    const points =
      groups.get(bucket)
        .sort(
          (a, b) =>
            a.timestamp - b.timestamp
        );

    if (!points.length) {
      continue;
    }

    candles.push({
      timestamp: bucket,

      open:
        points[0].price,

      high:
        Math.max(
          ...points.map(
            (p) => p.price
          )
        ),

      low:
        Math.min(
          ...points.map(
            (p) => p.price
          )
        ),

      close:
        points[points.length - 1].price
    });
  }

  return candles;
}

// ---------- LẤY MARKET DATA TỪ COINGECKO ----------

async function fetchCoinGeckoMarketData(symbol) {
  const coinId =
    COINGECKO_IDS[symbol];

  if (!coinId) {
    throw new Error(
      `Chưa có CoinGecko ID cho ${symbol}`
    );
  }

  // 90 ngày hourly => đủ dữ liệu để gom thành nến 4h.
  // Sau khi gom sẽ có khoảng 540 nến 4h,
  // đủ cho EMA200 + lookback.
  const url =
    `${COINGECKO_BASE_URL}/coins/${coinId}/market_chart` +
    `?vs_currency=usd&days=90&interval=hourly&precision=full`;

  const data =
    await fetchJSON(url);

  if (
    !data ||
    !Array.isArray(data.prices)
  ) {
    throw new Error(
      `CoinGecko trả dữ liệu không hợp lệ cho ${symbol}`
    );
  }

  const candles =
    aggregateHourlyTo4H(
      data.prices
    );

  if (candles.length < 200) {
    throw new Error(
      `CoinGecko không trả đủ dữ liệu 4h cho ${symbol}: ${candles.length} nến`
    );
  }

  const latest =
    candles[candles.length - 1];

  return {
    // CoinGecko định giá theo USD;
    // USDT gần 1:1 USD nên giữ nguyên
    // để không thay đổi logic tính toán phía dưới.
    currentPrice:
      latest.close,

    closes:
      candles.map(
        (c) => c.close
      ),

    highs:
      candles.map(
        (c) => c.high
      ),

    lows:
      candles.map(
        (c) => c.low
      ),

    source:
      'COINGECKO'
  };
}

// ---------- CHỌN NGUỒN DỮ LIỆU ----------

async function getMarketData(symbol) {
  const now =
    Date.now();

  // Nếu Binance đang trong thời gian ban
  // thì không gọi lại Binance ở từng coin.
  if (
    now < binanceBlockedUntil
  ) {
    return fetchCoinGeckoMarketData(
      symbol
    );
  }

  try {

    return await fetchBinanceMarketData(
      symbol
    );

  } catch (err) {

    // Nếu Binance lỗi thì fallback CoinGecko.
    try {

      return await fetchCoinGeckoMarketData(
        symbol
      );

    } catch (fallbackErr) {

      throw new Error(
        `${symbol}: Binance thất bại (${err.message}); ` +
        `CoinGecko fallback cũng thất bại (${fallbackErr.message})`
      );
    }
  }
}

// ---------- PHÂN TÍCH 1 COIN ----------

async function analyzeCoin(
  symbol,
  capital
) {
  const config =
    COINS_DATA[symbol];

  if (!config) {
    throw new Error(
      `Không có cấu hình cho symbol ${symbol}`
    );
  }

  const marketData =
    await getMarketData(symbol);

  const currentPrice =
    marketData.currentPrice;

  const closes =
    marketData.closes;

  const highs =
    marketData.highs;

  const lows =
    marketData.lows;

  const ema50 =
    calculateEMA(
      closes,
      50
    );

  const ema200 =
    calculateEMA(
      closes,
      200
    );

  const atr =
    calculateATR(
      highs,
      lows,
      closes,
      14
    );

  const high50 =
    Math.max(
      ...highs.slice(-50)
    );

  const trendInfo =
    generateForecast(
      closes,
      currentPrice,
      atr,
      symbol
    );

  const plan =
    generatePlan(
      currentPrice,
      ema50,
      ema200,
      atr,
      high50,
      symbol,
      trendInfo,
      capital
    );

  console.log(
    `📡 ${symbol}: dữ liệu từ ${marketData.source}`
  );

  return {
    symbol,
    config,
    currentPrice,
    ema50,
    ema200,
    atr,
    trendInfo,
    plan
  };
}

// ---------- FORMAT TIN NHẮN TELEGRAM ----------

function fmt(
  num,
  decimals
) {
  if (
    num === null ||
    num === undefined ||
    isNaN(num)
  ) {
    return '--';
  }

  return Number(num)
    .toFixed(decimals);
}

function trendEmoji(label) {

  if (
    label === 'UPTREND'
  ) {
    return '🟢';
  }

  if (
    label === 'DOWNTREND'
  ) {
    return '🔴';
  }

  if (
    label === 'NHIỄU (WEAK)'
  ) {
    return '⚪';
  }

  return '🟡';
}

function actionRecommendation(
  trendInfo
) {
  const c =
    trendInfo.confPercentNum;

  if (c < 32) {
    return 'Đứng ngoài quan sát, chưa đủ cơ sở để kết luận xu hướng.';
  }

  if (
    trendInfo.trendLabel ===
    'UPTREND'
  ) {
    return c >= 70
      ? 'Xu hướng tăng RÕ RÀNG → có thể vào đủ 3 Entry (30/30/40%).'
      : 'Xu hướng tăng trung bình → cẩn trọng, ưu tiên Entry 2 & 3, hạn chế đuổi giá ở Entry 1.';
  }

  if (
    trendInfo.trendLabel ===
    'DOWNTREND'
  ) {
    return c >= 45
      ? 'Downtrend MẠNH & rõ ràng → tạm khoá 2 Entry gần giá, chỉ chờ Entry 3 (Panic) bắt đáy sâu.'
      : 'Downtrend đã xác nhận → tạm khoá Entry 1 (gần giá nhất) để tránh bắt dao rơi.';
  }

  return 'Đi ngang (SIDEWAY) → chưa có tín hiệu vào lệnh rõ ràng, tiếp tục theo dõi.';
}

// ---------- TẠO MESSAGE TELEGRAM ----------

function buildTelegramMessage(
  result
) {
  const {
    symbol,
    config,
    currentPrice,
    trendInfo,
    plan
  } = result;

  const dec =
    config.decimals;

  const lines = [];

  lines.push(
    `${trendEmoji(trendInfo.trendLabel)} <b>${config.name} (${symbol})</b> — <b>${trendInfo.trendLabel}</b> (Độ tin cậy: ${trendInfo.confPercentNum}%)`
  );

  lines.push(
    `💰 Giá hiện tại: <b>${fmt(currentPrice, dec)}</b> USDT`
  );

  // CHỈ HIỂN THỊ NGƯỠNG TIÊU CHUẨN
  // Sức mạnh thực tế (changePct) vẫn được tính nội bộ
  // để xác định UPTREND / DOWNTREND nhưng KHÔNG gửi lên Telegram.
  lines.push(
    `📐 Ngưỡng tiêu chuẩn: ${trendInfo.trendThreshold.toFixed(2)}%`
  );

  lines.push('');

  lines.push(
    '<b>📋 Kế hoạch DCA:</b>'
  );

  plan.entries.forEach(
    (e) => {

      const statusTag =
        e.disabled
          ? '  <i>· CHỜ</i>'
          : '';

      lines.push(
        `\n▫️ <b>${e.name}</b>${statusTag}`
      );

      lines.push(
        `    💵 Giá vào: <b>${fmt(e.price, dec)}</b>`
      );

      if (
        e.stopLoss !== null
      ) {
        lines.push(
          `    🛑 Stop-Loss: ${fmt(e.stopLoss, dec)}`
        );
      }

      if (!e.disabled) {
        lines.push(
          `    🎯 Take-Profit: ${fmt(e.takeProfit, dec)}`
        );
      }
    }
  );

  if (
    plan.disabledCount > 0
  ) {

    lines.push('');

    lines.push(
      `⚠️ ${
        plan.disabledCount === 2
          ? 'Downtrend mạnh — đã khoá 2 Entry gần giá, chỉ chờ Entry sâu nhất (Panic).'
          : 'Downtrend đã xác nhận — đã khoá Entry gần giá nhất để tránh mua đuổi.'
      }`
    );
  }

  lines.push('');

  lines.push(
    `🎯 <b>Khuyến nghị:</b> ${actionRecommendation(trendInfo)}`
  );

  lines.push(
    `⏱ Cập nhật: ${new Date().toLocaleString(
      'vi-VN',
      {
        hour12: false,
        timeZone: 'Asia/Ho_Chi_Minh'
      }
    )}`
  );

  return lines.join('\n');
}

// ---------- GỬI TELEGRAM ----------

async function sendTelegramMessage(
  text
) {

  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {

    console.warn(
      '⚠️ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID — bỏ qua gửi Telegram.'
    );

    return;
  }

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const res =
    await fetch(
      url,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          chat_id:
            TELEGRAM_CHAT_ID,

          text,

          parse_mode:
            'HTML',

          disable_web_page_preview:
            true,
        }),
      }
    );

  if (!res.ok) {

    const errText =
      await res.text();

    throw new Error(
      `Gửi Telegram thất bại: HTTP ${res.status} - ${errText}`
    );
  }
}

// ---------- KIỂM TRA TELEGRAM ----------

async function verifyTelegramConfig() {

  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    return;
  }

  try {

    const res =
      await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`
      );

    const data =
      await res.json();

    if (
      res.ok &&
      data.ok
    ) {

      console.log(
        `✅ Telegram OK — bot: @${data.result.username}`
      );
    }

  } catch (err) {

    console.error(
      `❌ Lỗi kiểm tra Telegram: ${err.message}`
    );
  }
}

// ---------- GIỜ VIỆT NAM ----------

function nowStr() {
  return new Date().toLocaleString(
    'vi-VN',
    {
      hour12: false,
      timeZone:
        'Asia/Ho_Chi_Minh'
    }
  );
}

// ---------- CHẠY SCAN ----------

async function runScanCycle() {

  console.log(
    `\n🔍 [${nowStr()}] Bắt đầu tiến trình quét v9.3...`
  );

  for (
    const symbol of SYMBOLS
  ) {

    try {

      const result =
        await analyzeCoin(
          symbol,
          CAPITAL
        );

      const {
        trendInfo
      } = result;

      const isActionable =
        trendInfo.trendLabel ===
          'UPTREND' ||
        trendInfo.trendLabel ===
          'DOWNTREND';

      if (
        !isActionable ||
        trendInfo.confPercentNum <
          MIN_CONFIDENCE
      ) {

        console.log(
          `ℹ️  ${symbol}: Đang Sideway hoặc độ tin cậy chưa đủ (${trendInfo.confPercentNum}%). Bỏ qua.`
        );

        continue;
      }

      const message =
        buildTelegramMessage(
          result
        );

      await sendTelegramMessage(
        message
      );

      console.log(
        `✅ ${symbol}: Tín hiệu ${trendInfo.trendLabel} (${trendInfo.confPercentNum}%) — Đã gửi Telegram.`
      );

    } catch (err) {

      console.error(
        `❌ ${symbol}: Lỗi khi phân tích — ${err.message}`
      );
    }

    await new Promise(
      (r) =>
        setTimeout(
          r,
          800
        )
    );
  }
}

// ---------- HTTP SERVER ----------
// /ping = keep alive
// /scan = trigger scan thủ công

http
  .createServer(
    (req, res) => {

      // 1. Bỏ qua favicon
      if (
        req.url ===
        '/favicon.ico'
      ) {

        res.writeHead(
          204
        );

        return res.end();
      }

      // 2. Ping keep-alive
      if (
        req.url === '/ping' ||
        req.method === 'HEAD'
      ) {

        res.writeHead(
          200,
          {
            'Content-Type':
              'text/plain; charset=utf-8'
          }
        );

        return res.end(
          'OK'
        );
      }

      // 3. Scan thủ công
      if (
        req.url === '/scan'
      ) {

        res.writeHead(
          200,
          {
            'Content-Type':
              'text/plain; charset=utf-8'
          }
        );

        console.log(
          `\n🔔 [${nowStr()}] Nhận lệnh kích hoạt quét thủ công...`
        );

        runScanCycle()
          .catch(
            (err) =>
              console.error(
                `❌ Lỗi quét: ${err.message}`
              )
          );

        return res.end(
          'Crypto Swing Signal Bot v9.3: Đã nhận lệnh và đang tiến hành quét thị trường!\n'
        );
      }

      // 4. Các request khác trả OK
      res.writeHead(
        200,
        {
          'Content-Type':
            'text/plain; charset=utf-8'
        }
      );

      res.end(
        'OK'
      );
    }
  )
  .listen(
    PORT,
    () => {

      console.log(
        `🌐 Web Server đã khởi chạy trên cổng ${PORT}`
      );
    }
  );

// ---------- KHỞI ĐỘNG BOT ----------

(async () => {

  await verifyTelegramConfig();

  runScanCycle();

  setInterval(
    runScanCycle,
    SCAN_INTERVAL_MINUTES *
      60 *
      1000
  );

})();
