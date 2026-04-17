// inspect-endpoint.js — fetch /api/resourceLocation and print the structure
const puppeteer = require('puppeteer-core');

const BASE_URL = 'https://reservations.ontarioparks.ca';
const LOCAL_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function main() {
  const browser = await puppeteer.launch({
    executablePath: LOCAL_CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 45000 });

  const data = await page.evaluate(async () => {
    const res = await fetch('/api/resourceLocation', {
      headers: { 'Accept': 'application/json' },
      credentials: 'include',
    });
    return await res.json();
  });

  await browser.close();

  if (!Array.isArray(data)) {
    console.log('Not an array:', JSON.stringify(data).slice(0, 300));
    return;
  }

  console.log(`Total parks: ${data.length}\n`);
  console.log('=== First item (full structure) ===');
  console.log(JSON.stringify(data[0], null, 2));
  console.log('\n=== Algonquin matches ===');
  const matches = data.filter(p =>
    JSON.stringify(p).toLowerCase().includes('algonquin')
  );
  console.log(`Found ${matches.length} matching items`);
  matches.slice(0, 3).forEach(p => {
    // Print just the top-level keys and their values (not nested arrays)
    const summary = {};
    for (const [k, v] of Object.entries(p)) {
      if (!Array.isArray(v) && typeof v !== 'object') summary[k] = v;
    }
    console.log(JSON.stringify(summary));
  });
}

main().catch(console.error);
