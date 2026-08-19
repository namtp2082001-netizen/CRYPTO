const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

// Các biến môi trường Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'YOUR_TELEGRAM_CHAT_ID';

// Cấu hình danh sách coin & thông số
const SYMBOLS = ['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'LINKUSDT', 'SUIUSDT'];
const MIN_CONFIDENCE = 32; // Ngưỡng độ tin cậy tối thiểu (%)
const BINANCE_BASE_URLS = [
    'https://api.binance.com',
    'https://api1.binance.com',
    'https://api2.binance.com',
    'https://api3.binance.com'
];

let isScanning = false;
let scanTimeout = null;

// Hàm hỗ trợ delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Hàm gọi API Binance với cơ chế Retry & Rotate Host
async function fetchKlinesWithRetry(symbol, interval = '4h', limit = 100) {
    let lastError = null;
    for (const baseUrl of BINANCE_BASE_URLS) {
        try {
            const url = `${baseUrl}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
            const res = await axios.get(url, { timeout: 5000 });
            if (res.data && Array.isArray(res.data) && res.data.length > 0) {
                return res.data;
            }
        } catch (err) {
            lastError = err;
            await sleep(500); // Nghỉ 0.5s trước khi đổi Host
        }
    }
    throw lastError || new Error(`Không thể lấy dữ liệu klines cho ${symbol}`);
}

// Tính toán EMA
function calculateEMA(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

// Tính toán ATR (Average True Range)
function calculateATR(klines, period = 14) {
    let trs = [];
    for (let i = 1; i < klines.length; i++) {
        const high = parseFloat(klines[i][2]);
        const low = parseFloat(klines[i][3]);
        const prevClose = parseFloat(klines[i - 1][4]);
        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
        trs.push(tr);
    }
    const recentTrs = trs.slice(-period);
    const sum = recentTrs.reduce((a, b) => a + b, 0);
    return sum / period;
}

// Tính Hồi quy tuyến tính (Linear Regression Slope)
function calculateLinearRegressionSlope(prices) {
    const n = prices.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += prices[i];
        sumXY += i * prices[i];
        sumX2 += i * i;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    return slope;
}

// Hàm gửi tin nhắn Telegram
async function sendTelegramMessage(text) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: text,
            parse_mode: 'HTML'
        }, { timeout: 5000 });
        return true;
    } catch (err) {
        console.error('❌ Lỗi gửi Telegram:', err.message);
        return false;
    }
}

// Hàm phân tích kỹ thuật từng coin
async function analyzeSymbol(symbol) {
    const rawKlines = await fetchKlinesWithRetry(symbol, '4h', 100);
    const closes = rawKlines.map(k => parseFloat(k[4]));
    const currentPrice = closes[closes.length - 1];

    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const ema200 = calculateEMA(closes, 200);
    const atr = calculateATR(rawKlines, 14);

    const recentCloses = closes.slice(-20);
    const slope = calculateLinearRegressionSlope(recentCloses);

    // Tính toán Trend & Confidence
    let trend = 'SIDEWAY';
    let confidence = 0;

    const emaBull = ema20 > ema50 && ema50 > ema200;
    const emaBear = ema20 < ema50 && ema50 < ema200;

    if (emaBull && slope > 0) {
        trend = 'UPTREND';
    } else if (emaBear && slope < 0) {
        trend = 'DOWNTREND';
    }

    // Tính độ tin cậy dựa trên khoảng cách EMA & Slope
    const slopeFactor = Math.min(Math.abs(slope) / (currentPrice * 0.001), 1) * 40;
    const emaSpread = Math.abs(ema20 - ema200) / ema200 * 100;
    const emaFactor = Math.min(emaSpread / 5, 1) * 60;
    confidence = Math.round(slopeFactor + emaFactor);
    if (confidence > 99) confidence = 99;

    // Kế hoạch DCA
    const entry1 = currentPrice - (atr * 0.8);
    const entry2 = currentPrice - (atr * 1.8);
    const entry3 = currentPrice - (atr * 3.0);
    const stopLoss = entry3 - (atr * 1.2);
    const takeProfit = currentPrice + (atr * 2.5);

    return {
        symbol,
        currentPrice,
        trend,
        confidence,
        entry1,
        entry2,
        entry3,
        stopLoss,
        takeProfit,
        thresholdPercent: (atr / currentPrice * 100).toFixed(2)
    };
}

// Tiến trình chạy Scan toàn bộ coin
async function runCryptoScan() {
    console.log(`\n🔍 [${new Date().toLocaleString('vi-VN')}] Bắt đầu tiến trình quét v9.3...`);
    let okCount = 0;
    let errCount = 0;
    let sentCount = 0;

    for (const symbol of SYMBOLS) {
        try {
            const data = await analyzeSymbol(symbol);
            
            if ((data.trend === 'UPTREND' || data.trend === 'DOWNTREND') && data.confidence >= MIN_CONFIDENCE) {
                const icon = data.trend === 'UPTREND' ? '🟢' : '🔴';
                let msg = `${icon} <b>${data.symbol.replace('USDT', '')} (${data.symbol}) — ${data.trend} (Độ tin cậy: ${data.confidence}%)</b>\n`;
                msg += `💰 <b>Giá hiện tại:</b> ${data.currentPrice} USDT\n`;
                msg += `📐 <b>Ngưỡng xu hướng:</b> ${data.thresholdPercent}%\n\n`;
                msg += `📋 <b>Kế hoạch DCA:</b>\n`;
                msg += `▪ <b>Entry 1 (Pullback nhanh):</b> ${data.entry1.toFixed(4)}\n`;
                msg += `▪ <b>Entry 2 (Chuẩn):</b> ${data.entry2.toFixed(4)}\n`;
                msg += `▪ <b>Entry 3 (Panic):</b> ${data.entry3.toFixed(4)}\n`;
                msg += `🔴 <b>Stop-Loss:</b> ${data.stopLoss.toFixed(4)}\n`;
                msg += `🎯 <b>Take-Profit:</b> ${data.takeProfit.toFixed(4)}\n\n`;
                
                if (data.trend === 'UPTREND') {
                    msg += `🎯 <b>Khuyến nghị:</b> Xu hướng TĂNG rõ ràng → Ưu tiên canh nhịp Pullback gom Spot.`;
                } else {
                    msg += `⚠️ <b>Khuyến nghị:</b> DOWNTREND → Tạm khóa các Entry gần, ưu tiên quản trị rủi ro & giữ vốn.`;
                }
                msg += `\n⏰ <i>Cập nhật: ${new Date().toLocaleTimeString('vi-VN')}</i>`;

                const sent = await sendTelegramMessage(msg);
                if (sent) sentCount++;
                console.log(`✅ [${symbol}]: Tín hiệu ${data.trend} (${data.confidence}%) — Đã gửi Telegram.`);
            } else {
                console.log(`ℹ️ [${symbol}]: Đang Sideway hoặc độ tin cậy chưa đủ (${data.confidence}%). Bỏ qua.`);
            }
            okCount++;
        } catch (err) {
            errCount++;
            console.error(`❌ [${symbol}]: Lỗi phân tích - ${err.message}`);
        }

        // Dãn cách 1.5 giây giữa các coin
        await sleep(1500);
    }

    console.log(`🏁 [${new Date().toLocaleTimeString('vi-VN')}] Kết thúc scan — OK: ${okCount}, Lỗi: ${errCount}, Tín hiệu gửi: ${sentCount}`);
}

// ---------------- ROUTER HTTP ----------------

// Route Ping giữ server không ngủ
app.get('/ping', (req, res) => {
    res.status(200).send('PONG');
});

// Route Scan với cơ chế CHỐNG TREO CỜ VĨNH VIỄN
app.get('/scan', async (req, res) => {
    if (isScanning) {
        return res.status(200).send('SCAN_IN_PROGRESS');
    }

    // Đặt cờ đang quét
    isScanning = true;
    console.log(`\n🔔 [${new Date().toLocaleTimeString('vi-VN')}] Nhận request /scan từ Cron/HTTP — bắt đầu scan`);

    // Trả về response ngay lập tức cho Cron-job / Trình duyệt để tránh timeout (Non-blocking)
    res.status(200).json({ status: 'SCAN_STARTED', timestamp: new Date().toISOString() });

    // Cơ chế phòng thủ: Tự động mở khóa cờ sau tối đa 45 giây đề phòng sự cố
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => {
        if (isScanning) {
            console.warn('⚠️ Scan bị quá thời gian cho phép (45s). Tự động giải phóng cờ isScanning.');
            isScanning = false;
        }
    }, 45000);

    // Bắt đầu quét ngầm bên dưới
    try {
        await runCryptoScan();
    } catch (err) {
        console.error('❌ Lỗi tiến trình scan ngầm:', err.message);
    } finally {
        // BẮT BUỘC mở khóa cờ dù thành công hay thất bại
        isScanning = false;
        if (scanTimeout) clearTimeout(scanTimeout);
    }
});

// Khởi chạy Web Server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Web Server đã khởi chạy trên port ${PORT}`);
    console.log(`🔗 Health: /ping`);
    console.log(`🔗 Scan:   /scan`);
    console.log(`⚙️  Chế độ scan: Tự động khóa & chống kẹt 100%`);
});
