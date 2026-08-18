const axios = require('axios');

// Lấy thông tin từ Biến môi trường (Environment Variables) trên Render
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INTERVAL_MINUTES = parseInt(process.env.SCAN_INTERVAL_MINUTES || '15', 10); // Mặc định 15 phút quét 1 lần

// DATA CẤU HÌNH THEO ĐÚNG LOGIC V9.2
const COINS_DATA = {
    "SOLUSDT":  { name: "SOLANA",    atrMultiplier: 2.0, tpFactor: 1.15, decimals: 2, entryGaps: [0.8, 2.0, 3.6], trendThreshold: 1.3, regressionLookback: 36, momentumLookback: 8,  momentumWeight: 0.55 },
    "BTCUSDT":  { name: "BITCOIN",   atrMultiplier: 1.2, tpFactor: 1.05, decimals: 1, entryGaps: [0.6, 1.5, 2.6], trendThreshold: 0.8, regressionLookback: 50, momentumLookback: 12, momentumWeight: 0.40 },
    "ETHUSDT":  { name: "ETHEREUM",  atrMultiplier: 1.5, tpFactor: 1.08, decimals: 2, entryGaps: [0.7, 1.8, 3.2], trendThreshold: 1.0, regressionLookback: 42, momentumLookback: 10, momentumWeight: 0.50 },
    "BNBUSDT":  { name: "BNB CHAIN", atrMultiplier: 1.5, tpFactor: 1.08, decimals: 2, entryGaps: [0.7, 1.8, 3.2], trendThreshold: 1.0, regressionLookback: 42, momentumLookback: 10, momentumWeight: 0.50 },
    "LINKUSDT": { name: "CHAINLINK", atrMultiplier: 2.2, tpFactor: 1.18, decimals: 3, entryGaps: [0.9, 2.2, 4.0], trendThreshold: 1.5, regressionLookback: 34, momentumLookback: 8,  momentumWeight: 0.55 },
    "SUIUSDT":  { name: "SUI",       atrMultiplier: 2.0, tpFactor: 1.12, decimals: 4, entryGaps: [0.8, 2.1, 3.8], trendThreshold: 1.6, regressionLookback: 30, momentumLookback: 6,  momentumWeight: 0.60 }
};

// --- CÁC HÀM TÍNH TOÁN KỸ THUẬT V9.2 ---
function calculateEMA(data, period) {
    if (data.length < period) return data[data.length - 1];
    const k = 2 / (period + 1);
    let ema = data[0];
    for (let i = 0; i < period; i++) ema += data[i];
    ema = ema / period;
    for (let i = period; i < data.length; i++) ema = (data[i] * k) + (ema * (1 - k));
    return ema;
}

function calculateATR(highs, lows, closes, period) {
    if (highs.length < period) return 0;
    let trs = [];
    for (let i = 1; i < highs.length; i++) trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    let sum = 0;
    for (let i = trs.length - period; i < trs.length; i++) sum += trs[i];
    return sum / period;
}

function linearRegression(y) {
    const n = y.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) { sumX += i; sumY += y[i]; sumXY += i * y[i]; sumXX += i * i; }
    const denom = (n * sumXX - sumX * sumX) || 1;
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    const meanY = sumY / n;
    let ssTot = 0, ssRes = 0;
    for (let i = 0; i < n; i++) { const pred = intercept + slope * i; ssTot += Math.pow(y[i] - meanY, 2); ssRes += Math.pow(y[i] - pred, 2); }
    return { slope, intercept, r2: ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot) };
}

function generate7DayForecast(closes, times, currentPrice, atr, symbol) {
    const config = COINS_DATA[symbol] || { trendThreshold: 1.2, regressionLookback: 60, momentumLookback: 10, momentumWeight: 0.5 };
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
    let confidence = Math.max(0, reg.r2 * (1 - (volFactor * 0.5)));
    if (isNaN(confidence)) confidence = 0;

    const confPercentNum = Math.round(confidence * 100);
    const regChangePct = (predictions[6] - currentPrice) / currentPrice * 100;

    const momLookback = Math.min(closes.length - 1, config.momentumLookback || 10);
    const pastClose = closes[closes.length - 1 - momLookback];
    const momentumChangePct = pastClose ? ((currentPrice - pastClose) / pastClose * 100) : 0;
    const momWeight = config.momentumWeight != null ? config.momentumWeight : 0.5;

    const changePct = (momentumChangePct * momWeight) + (regChangePct * (1 - momWeight));

    const floorThreshold = config.trendThreshold || 1.2;
    const volBasedThreshold = (atr / Math.max(1e-9, currentPrice)) * 100 * 0.6;
    const trendThreshold = Math.max(floorThreshold, volBasedThreshold);

    let trendLabel = 'SIDEWAY';
    if (confPercentNum < 32) {
        trendLabel = 'NHIỄU (WEAK)';
    } else {
        if (changePct > trendThreshold) trendLabel = 'UPTREND';
        else if (changePct < -trendThreshold) trendLabel = 'DOWNTREND';
    }

    return { trendLabel, confPercentNum };
}

function enforceEntrySpacing(entries, atr, gaps) {
    const minGap12 = Math.max(0, gaps[1] - gaps[0]) * atr;
    const minGap23 = Math.max(0, gaps[2] - gaps[1]) * atr;
    if (entries[0].price - entries[1].price < minGap12) entries[1].price = entries[0].price - minGap12;
    if (entries[1].price - entries[2].price < minGap23) entries[2].price = entries[1].price - minGap23;
    return entries;
}

function generatePlan(price, e50, e200, atr, high50, symbol, trendInfo) {
    const config = COINS_DATA[symbol] || { atrMultiplier: 1.5, tpFactor: 1.1, decimals: 2, entryGaps: [0.7, 1.8, 3.2] };
    const gaps = config.entryGaps || [0.7, 1.8, 3.2];
    const conf = trendInfo ? trendInfo.confPercentNum : 0;
    const trendLabel = trendInfo ? trendInfo.trendLabel : 'SIDEWAY';
    const isUptrend = trendLabel === 'UPTREND';
    const isDowntrendZone = (price < e50 || price < e200);

    let entries;
    if (isUptrend) {
        let d1 = conf >= 70 ? 0.45 : (conf >= 40 ? 0.60 : 0.80);
        let d2 = conf >= 70 ? 1.05 : (conf >= 40 ? 1.20 : 1.45);
        let d3 = conf >= 70 ? 1.85 : (conf >= 40 ? 2.10 : 2.40);

        const entry1Price = price - d1 * atr;
        const entry2Raw = Math.min(price - d2 * atr, e50 + 0.25 * atr);
        const entry2Price = Math.min(entry2Raw, entry1Price - 0.45 * atr);
        const support3 = Math.min(price - d3 * atr, e50 - 0.35 * atr, e200 + 0.50 * atr);
        const entry3Price = Math.min(support3, entry2Price - 0.65 * atr);

        entries = [
            { desc: conf >= 70 ? 'Pullback nhanh' : 'Pullback 1', price: entry1Price, weight: 0.30 },
            { desc: 'EMA50 / Pullback sâu', price: entry2Price, weight: 0.30 },
            { desc: 'EMA200 / Panic', price: entry3Price, weight: 0.40 }
        ];
        entries = enforceEntrySpacing(entries, atr, [0.45, 1.05, 1.85]);
    } else if (isDowntrendZone) {
        let entry1Price = Math.min(price - (gaps[0] * atr), price * 0.98);
        let entry2Price = Math.min(price - (gaps[1] * atr), entry1Price * 0.96);
        let entry3Price = Math.min(price - (gaps[2] * atr), entry2Price * 0.94);

        entries = [
            { desc: 'Hỗ trợ 1', price: entry1Price, weight: 0.30 },
            { desc: 'Hỗ trợ 2', price: entry2Price, weight: 0.30 },
            { desc: 'Panic', price: entry3Price, weight: 0.40 }
        ];
        entries = enforceEntrySpacing(entries, atr, gaps);
    } else {
        entries = [
            { desc: 'EMA50 / Pullback', price: Math.min(e50, price - 0.70 * atr), weight: 0.30 },
            { desc: 'EMA200 / Support', price: Math.min(e200, price - 1.80 * atr), weight: 0.30 },
            { desc: 'Panic', price: Math.min(e200 - 2.0 * atr, price - 3.20 * atr), weight: 0.40 }
        ];
        entries = enforceEntrySpacing(entries, atr, gaps);
    }

    entries = entries.sort((a, b) => b.price - a.price);

    let disabledCount = 0;
    if (!isUptrend && isDowntrendZone && trendLabel === 'DOWNTREND') {
        disabledCount = conf >= 45 ? 2 : 1;
    }
    entries.forEach((e, idx) => { e.disabled = idx < disabledCount; });

    const targetRR = 1.8;
    entries.forEach(e => {
        let stopLoss = e.price - (config.atrMultiplier * atr);
        if (stopLoss <= 0) stopLoss = Math.max(0, e.price * 0.85);
        e.stopLoss = stopLoss;

        let tpFromRR = e.price + (e.price - stopLoss) * targetRR;
        let finalTP = isUptrend 
            ? Math.max(tpFromRR, high50 * 0.99, price * 1.02)
            : (isDowntrendZone ? Math.max(tpFromRR, price * 1.03) : Math.max(tpFromRR, high50 * 0.99));

        const maxAllowedTP = e.price * config.tpFactor;
        if (finalTP > maxAllowedTP) finalTP = maxAllowedTP;
        e.tp = finalTP;
    });

    return entries;
}

// --- HÀM GỬI THÔNG BÁO TELEGRAM ---
async function sendTelegramAlert(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.error("❌ Chưa cấu hình TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID!");
        return;
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log("✅ Đã gửi tín hiệu Telegram thành công.");
    } catch (err) {
        console.error("❌ Lỗi khi gửi Telegram:", err.message);
    }
}

// --- LOGIC QUÉT VÀ PHÂN TÍCH (MAIN WORKER LOOP) ---
async function runScan() {
    console.log(`\n🔍 [${new Date().toLocaleString('vi-VN')}] Bắt đầu quét thị trường...`);

    for (const symbol of Object.keys(COINS_DATA)) {
        try {
            const config = COINS_DATA[symbol];
            const [pRes, kRes] = await Promise.all([
                axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`),
                axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=4h&limit=300`)
            ]);

            const currentPrice = parseFloat(pRes.data.price);
            const kData = kRes.data;
            const closes = kData.map(d => parseFloat(d[4]));
            const highs = kData.map(d => parseFloat(d[2]));
            const lows = kData.map(d => parseFloat(d[3]));
            const times = kData.map(d => d[0]);

            const ema50 = calculateEMA(closes, 50);
            const ema200 = calculateEMA(closes, 200);
            const atr = calculateATR(highs, lows, closes, 14);

            const trendResult = generate7DayForecast(closes, times, currentPrice, atr, symbol);
            const planEntries = generatePlan(currentPrice, ema50, ema200, atr, Math.max(...highs.slice(-50)), symbol, trendResult);

            // BẮN TELEGRAM NẾU ĐẠT ĐIỀU KIỆN (Có UPTREND/DOWNTREND rõ ràng với độ tin cậy >= 40%)
            if (trendResult.confPercentNum >= 40 && trendResult.trendLabel !== 'SIDEWAY') {
                let msg = `📊 <b>SWING MASTER V9.2 REPORT</b>\n`;
                msg += `Coin: <b>${config.name} (${symbol})</b>\n`;
                msg += `Giá hiện tại: <b>$${currentPrice.toFixed(config.decimals)}</b>\n`;
                msg += `Xu hướng: <b>${trendResult.trendLabel}</b> (${trendResult.confPercentNum}%)\n\n`;
                msg += `<b>📌 CHIẾN LƯỢC ENTRY (DCA):</b>\n`;

                planEntries.forEach((e, idx) => {
                    if (e.disabled) {
                        msg += `• Entry ${idx + 1}: <b>$${e.price.toFixed(config.decimals)}</b> (🔒 <i>Khoá - Chờ Panic</i>)\n`;
                    } else {
                        msg += `• Entry ${idx + 1}: <b>$${e.price.toFixed(config.decimals)}</b> (Tỷ trọng ${(e.weight * 100)}%) | TP: $${e.tp.toFixed(config.decimals)}\n`;
                    }
                });

                msg += `\n⏰ <i>Time: ${new Date().toLocaleTimeString('vi-VN')}</i>`;
                await sendTelegramAlert(msg);
            }

        } catch (err) {
            console.error(`❌ Lỗi quét ${symbol}:`, err.message);
        }
    }
}

// Khởi chạy vòng lặp vô tận cho Background Worker
console.log(`🚀 Background Worker đã kích hoạt! Tự động quét mỗi ${INTERVAL_MINUTES} phút.`);
runScan();
setInterval(runScan, INTERVAL_MINUTES * 60 * 1000);