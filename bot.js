const http = require('http');
const axios = require('axios');

// ==========================================
// 1. TẠO HTTP SERVER (ĐỂ DÙNG FREE TRÊN RENDER WEB SERVICE)
// ==========================================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Crypto Swing Master v9.2 Web Service is Active & Running 24/7!');
}).listen(PORT, () => {
    console.log(`🌐 Web Server đã khởi chạy thành công trên cổng ${PORT}`);
});

// ==========================================
// 2. LẤY BIẾN MÔI TRƯỜNG & CẤU HÌNH BOT
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INTERVAL_MINUTES = parseInt(process.env.SCAN_INTERVAL_MINUTES || '15', 10);

// DATA CẤU HÌNH THEO ĐÚNG LOGIC V9.2
const COINS_DATA = {
    "SOLUSDT": { name: "SOLANA", atrMultiplier: 2.0, tpFactor: 1.15, decimals: 2, entryGaps: [0.8, 2.0, 3.6], trendThreshold: 1.3, regressionLookback: 36, momentumLookback: 8, momentumWeight: 0.55 },
    "BTCUSDT": { name: "BITCOIN", atrMultiplier: 1.2, tpFactor: 1.05, decimals: 1, entryGaps: [0.6, 1.5, 2.6], trendThreshold: 0.8, regressionLookback: 50, momentumLookback: 12, momentumWeight: 0.40 },
    "ETHUSDT": { name: "ETHEREUM", atrMultiplier: 1.5, tpFactor: 1.08, decimals: 2, entryGaps: [0.7, 1.8, 3.2], trendThreshold: 1.0, regressionLookback: 40, momentumLookback: 10, momentumWeight: 0.50 }
};

// ==========================================
// 3. CÁC HÀM TÍNH TOÁN KỸ THUẬT V9.2
// ==========================================

// Gửi thông báo về Telegram
async function sendTelegramAlert(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.error("❌ Chưa cấu hình TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong Environment Variables!");
        return;
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log("✅ Đã gửi báo cáo Telegram thành công.");
    } catch (error) {
        console.error("❌ Lỗi gửi Telegram:", error.response ? error.response.data : error.message);
    }
}

// Lấy nến từ Binance Spot
async function fetchKlines(symbol, interval = '15m', limit = 100) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const response = await axios.get(url);
    return response.data.map(d => ({
        time: d[0],
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4]),
        volume: parseFloat(d[5])
    }));
}

// Tính ATR
function calculateATR(klines, period = 14) {
    let trs = [];
    for (let i = 1; i < klines.length; i++) {
        const high = klines[i].high;
        const low = klines[i].low;
        const prevClose = klines[i - 1].close;
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trs.push(tr);
    }
    const recentTrs = trs.slice(-period);
    return recentTrs.reduce((a, b) => a + b, 0) / period;
}

// Tính Hồi quy tuyến tính (Linear Regression)
function calculateLinearRegressionSlope(prices) {
    const n = prices.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += prices[i];
        sumXY += i * prices[i];
        sumXX += i * i;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    return slope;
}

// Phân tích Xu hướng & Độ tin cậy (Confidence %)
function analyzeTrendV92(klines, config) {
    const closes = klines.map(k => k.close);
    const regPrices = closes.slice(-config.regressionLookback);
    const rawSlope = calculateLinearRegressionSlope(regPrices);
    const meanPrice = regPrices.reduce((a, b) => a + b, 0) / regPrices.length;
    const normalizedSlopePct = (rawSlope / meanPrice) * 100;

    const momPrices = closes.slice(-config.momentumLookback);
    const momentumPct = ((momPrices[momPrices.length - 1] - momPrices[0]) / momPrices[0]) * 100;

    const compositeScore = (normalizedSlopePct * (1 - config.momentumWeight)) + (momentumPct * config.momentumWeight);

    let trendLabel = 'SIDEWAY';
    if (compositeScore > config.trendThreshold) trendLabel = 'UPTREND';
    else if (compositeScore < -config.trendThreshold) trendLabel = 'DOWNTREND';

    let confPercentNum = Math.min(100, Math.round((Math.abs(compositeScore) / (config.trendThreshold * 2)) * 100));

    return { trendLabel, confPercentNum, compositeScore };
}

// ==========================================
// 4. MÁY QUÉT THỊ TRƯỜNG TỰ ĐỘNG
// ==========================================
async function runScanJob() {
    console.log(`\n🔍 [${new Date().toLocaleString('vi-VN')}] Bắt đầu tiến trình quét v9.2...`);

    for (const [symbol, config] of Object.entries(COINS_DATA)) {
        try {
            const klines = await fetchKlines(symbol, '15m', 100);
            const currentPrice = klines[klines.length - 1].close;
            const atr = calculateATR(klines, 14);
            const trendResult = analyzeTrendV92(klines, config);

            // Tính toán 3 mốc Entry DCA & TP
            const entry1 = currentPrice - (atr * config.entryGaps[0]);
            const entry2 = currentPrice - (atr * config.entryGaps[1]);
            const entry3 = currentPrice - (atr * config.entryGaps[2]);

            const planEntries = [
                { price: entry1, weight: 0.30, tp: entry1 * config.tpFactor },
                { price: entry2, weight: 0.40, tp: entry2 * config.tpFactor },
                { price: entry3, weight: 0.30, tp: entry3 * config.tpFactor, disabled: currentPrice > entry1 }
            ];

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
            } else {
                console.log(`ℹ️ ${symbol}: Thi hành Sideway hoặc độ tin cậy chưa đủ (${trendResult.confPercentNum}%). Bỏ qua gửi tin.`);
            }

        } catch (err) {
            console.error(`❌ Lỗi quét ${symbol}:`, err.message);
        }
    }
}

// ==========================================
// 5. KHỞI CHẠY ĐỊNH KỲ
// ==========================================
// Chạy quét ngay lập tức khi khởi động
runScanJob();

// Đặt lịch chạy định kỳ theo số phút thiết lập
setInterval(runScanJob, INTERVAL_MINUTES * 60 * 1000);
