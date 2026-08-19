// Binance public market-data endpoint.
// Theo tài liệu Binance, các API chỉ đọc dữ liệu thị trường công khai
// nên dùng data-api.binance.vision thay vì api.binance.com.
const BINANCE_MARKET_DATA_BASE = 'https://data-api.binance.vision';

async function fetchJSON(url) {
  // Chỉ thay base URL của Binance; toàn bộ endpoint, query và logic phân tích giữ nguyên.
  const requestUrl = url.startsWith('https://api.binance.com/')
    ? `${BINANCE_MARKET_DATA_BASE}${url.slice('https://api.binance.com'.length)}`
    : url;

  const res = await fetch(requestUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Crypto-Swing-Master-V9.3'
    }
  });

  if (!res.ok) {
    const retryAfter = res.headers.get('retry-after');

    throw new Error(
      `HTTP ${res.status} khi gọi ${requestUrl}` +
      (retryAfter ? ` (Retry-After: ${retryAfter}s)` : '')
    );
  }

  return res.json();
}
