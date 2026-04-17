// spy-network.js
//
// Loads Ontario Parks, interacts with the Park search input, and prints
// every Fetch/XHR network request that fires — so we can find the real
// search endpoint.
//
// Run: node spy-network.js

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
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Intercept every request to log it
  const captured = [];
  page.on('request', (req) => {
    const type = req.resourceType();
    if (['fetch', 'xhr'].includes(type)) {
      console.log(`→ [${type.toUpperCase()}] ${req.method()} ${req.url()}`);
    }
  });
  page.on('response', async (res) => {
    const type = res.request().resourceType();
    if (!['fetch', 'xhr'].includes(type)) return;
    if (res.status() === 200) {
      try {
        const body = await res.text();
        // Only print if it looks like park/location data
        if (body.includes('resourceLocationId') || body.includes('mapId') || body.includes('Algonquin')) {
          console.log(`\n🎯 MATCH! ${res.url()}`);
          console.log(`   Status: ${res.status()}`);
          console.log(`   Body preview: ${body.slice(0, 300)}\n`);
          captured.push({ url: res.url(), body: body.slice(0, 500) });
        }
      } catch {}
    }
  });

  console.log('Loading home page...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 45000 });
  console.log('Home page loaded.\n');

  // Try to find and click the Park/location search input
  console.log('Looking for Park search input...');

  // Try common selectors for the park autocomplete
  const selectors = [
    'input[placeholder*="park" i]',
    'input[placeholder*="location" i]',
    'input[placeholder*="search" i]',
    'input[aria-label*="park" i]',
    'input[aria-label*="location" i]',
    '.park-search input',
    '.location-search input',
    'app-resource-location-search input',
    'input[type="text"]',
  ];

  let found = false;
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 3000 });
      console.log(`Found input with selector: ${sel}`);
      await page.click(sel);
      await page.type(sel, 'Algo', { delay: 150 });
      console.log('Typed "Algo" — waiting for API calls...');
      await new Promise(r => setTimeout(r, 4000));
      found = true;
      break;
    } catch {}
  }

  if (!found) {
    console.log('Could not find Park input automatically.');
    console.log('Waiting 10s for any background API calls...');
    await new Promise(r => setTimeout(r, 10000));
  }

  await browser.close();

  if (captured.length === 0) {
    console.log('\n❌ No matching API responses captured.');
    console.log('The search endpoint may use POST, or requires more specific interaction.');
  } else {
    console.log('\n✅ Captured endpoints:');
    captured.forEach(c => console.log(' •', c.url));
  }
}

main().catch(console.error);
