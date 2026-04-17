// test if /api/resourceLocation works without Puppeteer
const https = require('https');

const url = 'https://reservations.ontarioparks.ca/api/resourceLocation';

const req = https.get(url, {
  headers: {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest',
  }
}, (res) => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      const data = JSON.parse(body);
      console.log('✅ Works without Puppeteer! Got', Array.isArray(data) ? data.length : '?', 'items');
      if (Array.isArray(data) && data.length > 0) {
        const en = data[0].localizedValues?.find(v => v.cultureName === 'en-CA');
        console.log('First park:', en?.fullName);
      }
    } catch {
      console.log('❌ Not JSON. Body preview:', body.slice(0, 200));
    }
  });
});

req.on('error', e => console.error('Error:', e.message));
