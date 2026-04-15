// scraper.js
//
// Puppeteer-based scraper for the Ontario Parks reservation website.
// Visits https://reservations.ontarioparks.ca and reads real availability.
//
// Strategy 1 (primary):
//   Calls the internal availability API endpoint directly and parses JSON.
//   This is fast and reliable when the API is reachable.
//
// Strategy 2 (fallback):
//   Intercepts XHR network responses from the booking results page,
//   capturing the same availability data that the page itself uses.
//   More robust than CSS-selector scraping because it doesn't depend on
//   class names that change with every front-end build.

const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const BASE_URL = 'https://reservations.ontarioparks.ca';
const PAGE_TIMEOUT = 30000; // 30 seconds per page load
const MAX_RETRIES = 2;      // retry transient failures up to this many times

// ── Utility ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Format a Date or Firestore Timestamp as YYYY-MM-DD
function formatDate(date) {
  const d = new Date(date);
  return d.toISOString().split('T')[0];
}

// Build the Ontario Parks booking results URL for a campground + date range.
// This URL is also used as the "Book Now" deep link sent in notifications.
function buildBookingUrl(campgroundId, checkIn, checkOut, mapId) {
  const params = new URLSearchParams({
    resourceLocationId: campgroundId || '-2147483648',
    mapId: mapId || '-2147483648',
    searchTabGroupId: '0',
    bookingCategoryId: '0',
    startDate: checkIn,
    endDate: checkOut,
    nights: '1',
    isReserving: 'true',
    equipmentId: '-32768',
    subEquipmentId: '-32768',
    partySize: '1',
  });
  return `${BASE_URL}/create-booking/results?${params.toString()}`;
}

// Build the direct availability API URL
function buildAvailabilityApiUrl(campgroundId, mapId, checkIn, checkOut) {
  const params = new URLSearchParams({
    mapId: mapId || '-2147483648',
    resourceLocationId: campgroundId,
    equipmentId: '-32768',
    subEquipmentId: '-32768',
    startDate: checkIn,
    endDate: checkOut,
    partySize: '1',
  });
  return `${BASE_URL}/api/availability/map?${params.toString()}`;
}

// Build the campground search API URL
function buildSearchUrl(query) {
  const params = new URLSearchParams({
    resourceLocationId: '-2147483648',
    searchString: query,
    resourceLocationTypeId: '1',
  });
  return `${BASE_URL}/api/resourcelocation/search?${params.toString()}`;
}

// ── Browser ───────────────────────────────────────────────────────────────────

async function launchBrowser() {
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: true,
  });
}

// Create a new page with a realistic user agent
async function newPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1280, height: 800 });
  return page;
}

// Fetch a URL and parse its body as JSON, using an existing browser page.
// Returns parsed JSON on success, null on any error.
//
// Why response interception instead of document.body.innerText:
//   Headless Chromium renders JSON API URLs through its built-in JSON viewer,
//   which wraps the payload in a shadow-DOM structure.  innerText on that
//   structure does NOT return the raw JSON — JSON.parse silently throws and
//   the function returns null.  Intercepting the raw HTTP response body avoids
//   Chrome's rendering pipeline entirely and is the most reliable approach.
async function fetchJson(browser, url) {
  const page = await newPage(browser);
  let capturedJson = null;

  // Primary: capture the raw response before Chrome processes it
  page.on('response', async (response) => {
    try {
      if (response.url() === url && response.status() === 200) {
        capturedJson = await response.json();
      }
    } catch {
      // Body was not valid JSON — will fall back below
    }
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT });

    if (capturedJson !== null) return capturedJson;

    // Fallback: Chrome JSON viewer wraps content in a <pre> tag
    const text = await page.evaluate(() => {
      const pre = document.querySelector('pre');
      return pre ? pre.innerText : document.body.innerText;
    });
    return JSON.parse(text.trim());
  } catch (err) {
    console.warn(`[Scraper] fetchJson failed for ${url}: ${err.message}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Parse availability API response ──────────────────────────────────────────
//
// Ontario Parks availability API response shape:
//   {
//     resourceAvailabilities: {
//       "<siteId>": { "<date>": <code>, ... },
//       ...
//     },
//     resourceMap: {
//       "<siteId>": { "name": "Site 001", ... },
//       ...
//     }
//   }
//
// Availability codes:
//   0  = Available
//   1+ = Not available (reserved, closed, maintenance, etc.)
//
// A site is considered available only when ALL dates in the range are code 0.

function parseAvailabilityResponse(apiData, watch, checkIn, checkOut) {
  if (!apiData || !apiData.resourceAvailabilities) return null;

  const available = [];

  for (const [siteId, dateMap] of Object.entries(apiData.resourceAvailabilities)) {
    // All dates in the range must be available (code 0)
    const codes = Object.values(dateMap);
    if (codes.length === 0) continue;
    const allAvailable = codes.every((code) => code === 0 || code === '0');
    if (!allAvailable) continue;

    const siteName = apiData.resourceMap?.[siteId]?.name || `Site ${siteId}`;

    // If the user requested a specific site number, filter to it
    if (watch.siteNumber && watch.siteNumber !== '') {
      const target = watch.siteNumber.toLowerCase();
      if (
        siteName.toLowerCase() !== target &&
        siteId !== watch.siteNumber
      ) {
        continue;
      }
    }

    available.push({
      siteId,
      siteName,
      checkIn,
      checkOut,
      bookingUrl: buildBookingUrl(watch.campgroundId, checkIn, checkOut, watch.mapId),
    });
  }

  return available;
}

// ── Strategy 2: network interception ─────────────────────────────────────────
//
// Loads the booking results page and captures the availability API response
// as it flies over the network — the same data Strategy 1 fetches directly,
// but retrieved through the page's own request rather than a separate fetch.
// This works even if the direct API URL requires a session cookie set by the
// main page load.

async function checkAvailabilityViaInterception(browser, watch, checkIn, checkOut) {
  const apiPattern = /\/api\/availability\//;
  const bookingUrl = buildBookingUrl(watch.campgroundId, checkIn, checkOut, watch.mapId);

  let capturedData = null;

  const page = await newPage(browser);

  try {
    // Listen for matching network responses and capture the JSON body
    page.on('response', async (response) => {
      if (apiPattern.test(response.url()) && response.status() === 200) {
        try {
          const json = await response.json();
          if (json && json.resourceAvailabilities) {
            capturedData = json;
            console.log(`[Scraper] Intercepted availability response from ${response.url()}`);
          }
        } catch {
          // Response body was not JSON — ignore
        }
      }
    });

    await page.goto(bookingUrl, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT });

    // Give the SPA a moment to fire any deferred requests
    await sleep(3000);

  } finally {
    await page.close().catch(() => {});
  }

  if (!capturedData) return null;
  return parseAvailabilityResponse(capturedData, watch, checkIn, checkOut);
}

// ── checkAvailability ─────────────────────────────────────────────────────────
// Public API. Returns an array of available sites:
//   [{ siteId, siteName, checkIn, checkOut, bookingUrl }]
//
// Attempts Strategy 1, falls back to Strategy 2, retries on transient errors.

async function checkAvailability(watch, attempt = 0) {
  const checkIn = formatDate(
    watch.checkIn?.toDate ? watch.checkIn.toDate() : watch.checkIn
  );
  const checkOut = formatDate(
    watch.checkOut?.toDate ? watch.checkOut.toDate() : watch.checkOut
  );

  console.log(
    `[Scraper] Checking watch ${watch.id} — ${watch.campgroundName} ` +
    `(${checkIn} → ${checkOut})${attempt > 0 ? ` [retry ${attempt}]` : ''}`
  );

  let browser;
  try {
    browser = await launchBrowser();

    // ── Strategy 1: direct API call ───────────────────────────────────────────
    const apiUrl = buildAvailabilityApiUrl(
      watch.campgroundId,
      watch.mapId,
      checkIn,
      checkOut
    );
    console.log(`[Scraper] Strategy 1 — ${apiUrl}`);

    const apiData = await fetchJson(browser, apiUrl);
    const s1Results = parseAvailabilityResponse(apiData, watch, checkIn, checkOut);

    if (s1Results !== null) {
      console.log(`[Scraper] Strategy 1 found ${s1Results.length} available site(s)`);
      return s1Results;
    }

    // ── Strategy 2: network interception ─────────────────────────────────────
    console.log('[Scraper] Strategy 1 returned no data — falling back to interception');
    const s2Results = await checkAvailabilityViaInterception(browser, watch, checkIn, checkOut);

    if (s2Results !== null) {
      console.log(`[Scraper] Strategy 2 found ${s2Results.length} available site(s)`);
      return s2Results;
    }

    console.log('[Scraper] Both strategies returned no data — assuming no availability');
    return [];

  } catch (err) {
    console.error(`[Scraper] Error on watch ${watch.id}:`, err.message);

    // Retry on transient errors (network blip, Puppeteer crash, etc.)
    if (attempt < MAX_RETRIES) {
      const delay = (attempt + 1) * 3000;
      console.log(`[Scraper] Retrying in ${delay}ms...`);
      await sleep(delay);
      return checkAvailability(watch, attempt + 1);
    }

    return [];
  } finally {
    if (browser) {
      await browser.close().catch((err) => {
        console.warn('[Scraper] Error closing browser:', err.message);
      });
    }
  }
}

// ── searchCampgrounds ─────────────────────────────────────────────────────────
// Public API. Returns an array:
//   [{ id, name, region, mapId }]
//
// Used by the GET /campgrounds endpoint in server.js.

async function searchCampgrounds(query) {
  console.log(`[Scraper] Searching campgrounds: "${query}"`);

  let browser;
  try {
    browser = await launchBrowser();
    const data = await fetchJson(browser, buildSearchUrl(query));

    if (!Array.isArray(data)) {
      console.warn('[Scraper] Search response was not an array');
      return [];
    }

    const results = data.map((item) => ({
      id: String(item.resourceLocationId || ''),
      name: item.name || '',
      region: item.regionName || '',
      mapId: String(item.defaultMapId || '-2147483648'),
    }));

    console.log(`[Scraper] Search returned ${results.length} campground(s)`);
    return results;
  } catch (err) {
    console.error('[Scraper] searchCampgrounds error:', err.message);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { checkAvailability, searchCampgrounds, formatDate, buildBookingUrl };
