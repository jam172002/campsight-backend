// scraper.js
//
// Scraper for the Ontario Parks reservation website.
//
// searchCampgrounds — plain HTTPS (no browser):
//   GET /api/resourceLocation returns all parks as JSON without session cookies.
//
// checkAvailability — Puppeteer:
//   Strategy 1: calls the internal availability API directly and parses JSON.
//   Strategy 2: intercepts XHR responses from the booking results page.
//
// IMPORTANT:
//   Availability code 0 = available.
//   Any other value = not available / booked / closed / restricted.
//   We only return a site when EVERY required night is code 0.

const https = require('https');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const BASE_URL = 'https://reservations.ontarioparks.ca';
const PAGE_TIMEOUT = 30000;
const MAX_RETRIES = 2;

const RESOURCE_LOCATION_URL = `${BASE_URL}/api/resourceLocation`;

// ── Utility ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatDate(date) {
  if (!date) return '';

  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';

  return d.toISOString().split('T')[0];
}

function dateRangeNights(checkIn, checkOut) {
  const start = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

  const dates = [];
  const current = new Date(start);

  while (current < end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

function normalizeSite(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^site\s*/i, '')
    .replace(/^campsite\s*/i, '')
    .replace(/^0+/, '')
    .trim();
}

function isZeroCode(code) {
  return code === 0 || code === '0';
}

function buildBookingUrl(campgroundId, checkIn, checkOut, mapId, siteId) {
  const params = new URLSearchParams({
    resourceLocationId: campgroundId || '-2147483648',
    mapId: mapId || '-2147483648',
    searchTabGroupId: '0',
    bookingCategoryId: '0',
    startDate: checkIn,
    endDate: checkOut,
    nights: String(dateRangeNights(checkIn, checkOut).length || 1),
    isReserving: 'true',
    equipmentId: '-32768',
    subEquipmentId: '-32768',
    partySize: '1',
  });

  if (siteId) params.set('resourceId', String(siteId));

  return `${BASE_URL}/create-booking/results?${params.toString()}`;
}

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

// ── Browser ───────────────────────────────────────────────────────────────────

async function launchBrowser() {
  const isWindows = process.platform === 'win32';
  const localChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  if (isWindows) {
    return puppeteer.launch({
      executablePath: localChrome,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1280, height: 800 },
    });
  }

  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: true,
  });
}

async function newPage(browser) {
  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  await page.setViewport({ width: 1280, height: 800 });

  return page;
}

// Strategy 1: establish a browser session on the main page, then call the
// availability API from within the browser context so session cookies are
// included.  Direct navigation to the API URL (old approach) returned a login
// redirect with no JSON because the endpoint requires an active session.
async function callAvailabilityApiWithSession(browser, apiUrl) {
  const page = await newPage(browser);

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    const data = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          credentials: 'include',
        });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    }, apiUrl);

    return data;
  } catch (err) {
    console.warn(`[Scraper] callAvailabilityApiWithSession failed: ${err.message}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Availability Parsing ──────────────────────────────────────────────────────

function parseAvailabilityResponse(apiData, watch, checkIn, checkOut) {
  if (!apiData || !apiData.resourceAvailabilities) {
    console.warn('[Scraper] Invalid availability response: missing resourceAvailabilities');
    return null;
  }

  const requiredDates = dateRangeNights(checkIn, checkOut);

  if (requiredDates.length === 0) {
    console.warn(`[Scraper] Invalid date range: ${checkIn} → ${checkOut}`);
    return [];
  }

  const available = [];
  const targetSite = normalizeSite(watch.siteNumber);

  for (const [siteId, dateMap] of Object.entries(apiData.resourceAvailabilities)) {
    if (!dateMap || typeof dateMap !== 'object') continue;

    const resourceInfo = apiData.resourceMap?.[siteId] || {};
    const siteName = resourceInfo.name || `Site ${siteId}`;

    // Specific site filter.
    // Handles:
    //   user input: "12"
    //   API name: "Site 012"
    //   API id: "012"
    if (targetSite) {
      const normalizedSiteId = normalizeSite(siteId);
      const normalizedSiteName = normalizeSite(siteName);

      if (normalizedSiteId !== targetSite && normalizedSiteName !== targetSite) {
        continue;
      }
    }

    // Important false-alert fix:
    // Check every required night by exact date key.
    // Do NOT use Object.values(dateMap), because the API may contain extra dates,
    // missing dates, or dates outside the user's requested range.
    let allRequiredDatesAvailable = true;

    for (const date of requiredDates) {
      const code = dateMap[date];

      // Missing date means unsafe/unknown, so treat as NOT available.
      if (code === undefined || code === null) {
        allRequiredDatesAvailable = false;
        break;
      }

      // Only code 0 is available. Anything else means booked/unavailable.
      if (!isZeroCode(code)) {
        allRequiredDatesAvailable = false;
        break;
      }
    }

    if (!allRequiredDatesAvailable) continue;

    available.push({
      siteId,
      siteName,
      checkIn,
      checkOut,
      bookingUrl: buildBookingUrl(watch.campgroundId, checkIn, checkOut, watch.mapId, siteId),
    });
  }

  return available;
}

// ── Strategy 2: Network Interception ──────────────────────────────────────────

async function checkAvailabilityViaInterception(browser, watch, checkIn, checkOut) {
  const bookingUrl = buildBookingUrl(watch.campgroundId, checkIn, checkOut, watch.mapId);

  let capturedData = null;
  const page = await newPage(browser);

  try {
    page.on('response', async (response) => {
      try {
        const resUrl = response.url();

        // Only accept the availability/map endpoint that matches our exact
        // campground and date parameters.  The booking SPA can fire multiple
        // /api/availability/* calls (calendar view, category checks, etc.) and
        // capturing the wrong one caused false-positive alerts.
        if (
          resUrl.includes('/api/availability/map') &&
          resUrl.includes(`resourceLocationId=${watch.campgroundId}`) &&
          resUrl.includes(`startDate=${checkIn}`) &&
          response.status() === 200
        ) {
          const json = await response.json();

          if (json && json.resourceAvailabilities) {
            capturedData = json;
            console.log(`[Scraper] Intercepted availability response from ${resUrl}`);
          }
        }
      } catch {
        // Ignore non-JSON or already-consumed response bodies.
      }
    });

    await page.goto(bookingUrl, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT });

    await sleep(3000);
  } catch (err) {
    console.warn(`[Scraper] Interception failed: ${err.message}`);
  } finally {
    await page.close().catch(() => {});
  }

  if (!capturedData) return null;

  return parseAvailabilityResponse(capturedData, watch, checkIn, checkOut);
}

// ── checkAvailability ─────────────────────────────────────────────────────────

async function checkAvailability(watch, attempt = 0) {
  const checkIn = formatDate(
    watch.checkIn?.toDate ? watch.checkIn.toDate() : watch.checkIn
  );

  const checkOut = formatDate(
    watch.checkOut?.toDate ? watch.checkOut.toDate() : watch.checkOut
  );

  if (!checkIn || !checkOut) {
    console.warn(`[Scraper] Watch ${watch.id} has invalid dates`);
    return [];
  }

  console.log(
    `[Scraper] Checking watch ${watch.id} — ${watch.campgroundName} ` +
      `(${checkIn} → ${checkOut})${attempt > 0 ? ` [retry ${attempt}]` : ''}`
  );

  let browser;

  try {
    browser = await launchBrowser();

    const apiUrl = buildAvailabilityApiUrl(
      watch.campgroundId,
      watch.mapId,
      checkIn,
      checkOut
    );

    console.log(`[Scraper] Strategy 1 — ${apiUrl}`);

    const apiData = await callAvailabilityApiWithSession(browser, apiUrl);
    const s1Results = parseAvailabilityResponse(apiData, watch, checkIn, checkOut);

    if (s1Results !== null) {
      console.log(`[Scraper] Strategy 1 found ${s1Results.length} available site(s)`);
      return s1Results;
    }

    console.log('[Scraper] Strategy 1 returned no data — falling back to interception');

    const s2Results = await checkAvailabilityViaInterception(
      browser,
      watch,
      checkIn,
      checkOut
    );

    if (s2Results !== null) {
      console.log(`[Scraper] Strategy 2 found ${s2Results.length} available site(s)`);
      return s2Results;
    }

    console.log('[Scraper] Both strategies returned no data — assuming no availability');
    return [];
  } catch (err) {
    console.error(`[Scraper] Error on watch ${watch.id}:`, err.message);

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

// ── Campground Search ─────────────────────────────────────────────────────────

function fetchAllParks() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      RESOURCE_LOCATION_URL,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'X-Requested-With': 'XMLHttpRequest',
        },
      },
      (res) => {
        let body = '';

        res.on('data', (chunk) => {
          body += chunk;
        });

        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(
              new Error(`/api/resourceLocation returned ${res.statusCode}`)
            );
          }

          try {
            resolve(JSON.parse(body));
          } catch {
            reject(
              new Error(
                `/api/resourceLocation body is not JSON: ${body.slice(0, 100)}`
              )
            );
          }
        });
      }
    );

    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('/api/resourceLocation request timed out'));
    });

    req.on('error', reject);
  });
}

async function searchCampgrounds(query) {
  console.log(`[Scraper] Searching campgrounds: "${query}"`);

  const apiData = await fetchAllParks();

  if (!Array.isArray(apiData)) {
    console.warn('[Scraper] /api/resourceLocation did not return an array');
    return [];
  }

  console.log(`[Scraper] Loaded ${apiData.length} parks — filtering for "${query}"...`);

  const q = String(query || '').toLowerCase().trim();

  const results = apiData
    .map((item) => {
      const en =
        item.localizedValues?.find((v) => v.cultureName === 'en-CA') ||
        item.localizedValues?.[0];

      return {
        id: String(item.resourceLocationId || ''),
        name: en?.fullName || en?.shortName || '',
        region: item.region || '',
        mapId: String(item.rootMapId || '-2147483648'),
      };
    })
    .filter((item) => {
      return (
        item.name.toLowerCase().includes(q) ||
        item.region.toLowerCase().includes(q)
      );
    });

  console.log(`[Scraper] Search returned ${results.length} campground(s)`);

  return results;
}

module.exports = {
  checkAvailability,
  searchCampgrounds,
  formatDate,
  buildBookingUrl,
};