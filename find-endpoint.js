// find-endpoint.js
//
// Tries several plausible Ontario Parks search endpoint patterns
// to find which one returns actual data.
// Run: node find-endpoint.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'https://reservations.ontarioparks.ca';
const LOCAL_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const QUERY = 'Algonquin';

const CANDIDATES = [
  // original (known 404)
  `/api/resourcelocation/search?resourceLocationId=-2147483648&searchString=${QUERY}&resourceLocationTypeId=1`,
  // versioned variants
  `/api/v1/resourcelocation/search?resourceLocationId=-2147483648&searchString=${QUERY}&resourceLocationTypeId=1`,
  `/api/v2/resourcelocation/search?resourceLocationId=-2147483648&searchString=${QUERY}&resourceLocationTypeId=1`,
  // plural
  `/api/resourcelocations/search?searchString=${QUERY}`,
  `/api/resourcelocations?searchString=${QUERY}`,
  `/api/resourcelocations?q=${QUERY}`,
  // different naming
  `/api/parks/search?q=${QUERY}`,
  `/api/park/search?q=${QUERY}`,
  `/api/location/search?q=${QUERY}`,
  `/api/search?q=${QUERY}&type=park`,
  // booking-specific
  `/create-booking/api/search?q=${QUERY}`,
  // with different param names
  `/api/resourcelocation/search?searchText=${QUERY}`,
  `/api/resourcelocation/search?name=${QUERY}`,
  `/api/resourcelocation/search?query=${QUERY}`,
];

async function main() {
  console.log('Launching browser and loading Ontario Parks home page...\n');

  const browser = await puppeteer.launch({
    executablePath: LOCAL_CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Establish session
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('Session established. Testing endpoints...\n');

  for (const path of CANDIDATES) {
    const url = BASE_URL + path;
    try {
      const result = await page.evaluate(async (u) => {
        const res = await fetch(u, {
          headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          credentials: 'include',
        });
        const text = await res.text();
        return { status: res.status, snippet: text.slice(0, 120) };
      }, url);

      const icon = result.status === 200 ? '✅' : result.status === 404 ? '❌' : '⚠️';
      console.log(`${icon} [${result.status}] ${path}`);
      if (result.status === 200) {
        console.log(`   → ${result.snippet}\n`);
      }
    } catch (e) {
      console.log(`💥 [ERR] ${path} — ${e.message}`);
    }
  }

  await browser.close();
  console.log('\nDone.');
}

main().catch(console.error);
