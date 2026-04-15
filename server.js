// server.js
//
// CampSight backend — entry point.
//
// Responsibilities:
//   - Express HTTP server (required by Render.com)
//   - Full REST API: campground search, watch CRUD, alert history, FCM token
//   - Global rate limiting + Firebase Auth token verification
//   - Cron job running the alert engine every 60 seconds
//   - Self-ping keep-alive to prevent Render free tier sleep

require('dotenv').config();

const express = require('express');
const cron = require('node-cron');
const https = require('https');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

const { initFirebase, getFirestore } = require('./firebase');
const { runAlertEngine } = require('./alertEngine');
const { searchCampgrounds } = require('./scraper');
const cache = require('./cache');

const app = express();
const PORT = process.env.PORT || 10000;

// ── Firebase init ─────────────────────────────────────────────────────────────
initFirebase();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());

// Global rate limit: 120 requests / minute per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down' },
});
app.use(globalLimiter);

// Tighter limit on campground search: each call may spin up Puppeteer
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Too many search requests' },
});

// Watch + alert endpoints
const watchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests' },
});

// ── Auth helpers ──────────────────────────────────────────────────────────────

// Verifies the Firebase Auth ID token sent by the Flutter app as:
//   Authorization: Bearer <idToken>
async function verifyFirebaseToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  try {
    const token = header.split(' ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.userId = decoded.uid;
    next();
  } catch (err) {
    console.warn('[Auth] Token verification failed:', err.message);
    return res.status(401).json({ error: 'Unauthorized — invalid or expired token' });
  }
}

// Protects the manual /trigger endpoint with a shared secret:
//   x-trigger-secret: <value of TRIGGER_SECRET env var>
function requireTriggerSecret(req, res, next) {
  const secret = process.env.TRIGGER_SECRET;
  if (!secret) {
    console.error('[Auth] TRIGGER_SECRET is not configured');
    return res.status(503).json({ error: 'Admin endpoints not configured' });
  }
  if (req.headers['x-trigger-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'CampSight Scraper',
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(process.uptime())}s`,
  });
});

// ── Engine status ─────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({
    status: 'running',
    lastRun: global.lastEngineRun || null,
    lastRunDurationMs: global.lastRunDurationMs || null,
    totalRuns: global.totalRuns || 0,
    nextRun: 'within 60 seconds',
  });
});

// ── Campground search ─────────────────────────────────────────────────────────
// GET /campgrounds?q=algonquin
//
// Called by the Flutter app while the user types in the campground picker.
// Results are cached for 1 hour to avoid launching Puppeteer on every keystroke.
app.get('/campgrounds', searchLimiter, async (req, res) => {
  const q = (req.query.q || '').trim();

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }
  if (q.length > 100) {
    return res.status(400).json({ error: 'Query too long' });
  }

  const cacheKey = `campgrounds:${q.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json({ results: cached, source: 'cache' });
  }

  try {
    const results = await searchCampgrounds(q);
    if (results.length > 0) {
      cache.set(cacheKey, results, 60 * 60 * 1000); // cache 1 hour
    }
    res.json({ results, source: 'live' });
  } catch (err) {
    console.error('[Server] Campground search error:', err.message);
    res.status(500).json({ error: 'Search failed — please try again' });
  }
});

// ── Watch management ──────────────────────────────────────────────────────────
// Watch CRUD is handled here (not by direct Firestore writes from the app)
// so the backend can enforce the 3-active-watch limit and validate inputs.

// GET /watches — list all watches for the authenticated user
app.get('/watches', watchLimiter, verifyFirebaseToken, async (req, res) => {
  const db = getFirestore();
  try {
    const snap = await db
      .collection('users').doc(req.userId)
      .collection('watches')
      .orderBy('createdAt', 'desc')
      .get();

    const watches = snap.docs.map((doc) => serializeWatch(doc));
    res.json({ watches });
  } catch (err) {
    console.error('[Server] List watches error:', err.message);
    res.status(500).json({ error: 'Failed to list watches' });
  }
});

// POST /watches — create a new watch
app.post('/watches', watchLimiter, verifyFirebaseToken, async (req, res) => {
  const db = getFirestore();
  const userId = req.userId;

  const { campgroundId, campgroundName, mapId, checkIn, checkOut, siteNumber } = req.body;

  // Validate required fields
  if (!campgroundId || !campgroundName || !checkIn || !checkOut) {
    return res.status(400).json({
      error: 'Missing required fields: campgroundId, campgroundName, checkIn, checkOut',
    });
  }

  // Validate dates
  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  if (isNaN(checkInDate) || isNaN(checkOutDate)) {
    return res.status(400).json({ error: 'Invalid date format — use YYYY-MM-DD' });
  }
  if (checkInDate >= checkOutDate) {
    return res.status(400).json({ error: 'checkOut must be after checkIn' });
  }
  if (checkInDate < new Date(new Date().toDateString())) {
    return res.status(400).json({ error: 'checkIn must be today or in the future' });
  }

  try {
    const watchesRef = db.collection('users').doc(userId).collection('watches');

    // Enforce 3-active-watch limit
    const activeSnap = await watchesRef.where('status', '==', 'active').get();
    if (activeSnap.size >= 3) {
      return res.status(409).json({
        error: 'Maximum of 3 active watches reached. Pause or delete a watch first.',
        activeCount: activeSnap.size,
      });
    }

    const watchData = {
      campgroundId: String(campgroundId),
      campgroundName: String(campgroundName),
      mapId: mapId ? String(mapId) : '-2147483648',
      checkIn: checkIn,
      checkOut: checkOut,
      siteNumber: siteNumber ? String(siteNumber).trim() : '',
      status: 'active',
      notificationsEnabled: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastChecked: null,
    };

    const docRef = await watchesRef.add(watchData);
    console.log(`[Server] Watch created: ${docRef.id} for user ${userId}`);

    res.status(201).json({
      watchId: docRef.id,
      message: 'Watch created',
      watch: { id: docRef.id, ...watchData, createdAt: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[Server] Create watch error:', err.message);
    res.status(500).json({ error: 'Failed to create watch' });
  }
});

// PATCH /watches/:watchId — update a watch (pause, resume, edit criteria)
app.patch('/watches/:watchId', watchLimiter, verifyFirebaseToken, async (req, res) => {
  const db = getFirestore();
  const userId = req.userId;
  const { watchId } = req.params;

  const allowedFields = ['status', 'siteNumber', 'checkIn', 'checkOut', 'notificationsEnabled'];
  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields provided' });
  }

  if (updates.status && !['active', 'paused'].includes(updates.status)) {
    return res.status(400).json({ error: 'status must be "active" or "paused"' });
  }

  try {
    const watchRef = db.collection('users').doc(userId).collection('watches').doc(watchId);
    const snap = await watchRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Watch not found' });

    // If resuming, re-check the 3-watch limit
    if (updates.status === 'active' && snap.data().status !== 'active') {
      const watchesRef = db.collection('users').doc(userId).collection('watches');
      const activeSnap = await watchesRef.where('status', '==', 'active').get();
      if (activeSnap.size >= 3) {
        return res.status(409).json({
          error: 'Maximum of 3 active watches reached. Pause another watch first.',
        });
      }
    }

    await watchRef.update(updates);
    res.json({ message: 'Watch updated', watchId, updates });
  } catch (err) {
    console.error('[Server] Update watch error:', err.message);
    res.status(500).json({ error: 'Failed to update watch' });
  }
});

// DELETE /watches/:watchId
app.delete('/watches/:watchId', watchLimiter, verifyFirebaseToken, async (req, res) => {
  const db = getFirestore();
  const userId = req.userId;
  const { watchId } = req.params;

  try {
    const watchRef = db.collection('users').doc(userId).collection('watches').doc(watchId);
    const snap = await watchRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Watch not found' });

    await watchRef.delete();
    console.log(`[Server] Watch deleted: ${watchId} for user ${userId}`);
    res.json({ message: 'Watch deleted', watchId });
  } catch (err) {
    console.error('[Server] Delete watch error:', err.message);
    res.status(500).json({ error: 'Failed to delete watch' });
  }
});

// ── Alert history ─────────────────────────────────────────────────────────────

// GET /watches/:watchId/alerts
app.get('/watches/:watchId/alerts', watchLimiter, verifyFirebaseToken, async (req, res) => {
  const db = getFirestore();
  const { watchId } = req.params;

  try {
    const snap = await db
      .collection('users').doc(req.userId)
      .collection('watches').doc(watchId)
      .collection('alerts')
      .orderBy('detectedAt', 'desc')
      .limit(50)
      .get();

    const alerts = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      detectedAt: doc.data().detectedAt?.toDate?.()?.toISOString() || null,
    }));

    res.json({ alerts });
  } catch (err) {
    console.error('[Server] List alerts error:', err.message);
    res.status(500).json({ error: 'Failed to list alerts' });
  }
});

// PATCH /watches/:watchId/alerts/:alertId — mark as seen
app.patch(
  '/watches/:watchId/alerts/:alertId',
  watchLimiter,
  verifyFirebaseToken,
  async (req, res) => {
    const db = getFirestore();
    const { watchId, alertId } = req.params;

    try {
      await db
        .collection('users').doc(req.userId)
        .collection('watches').doc(watchId)
        .collection('alerts').doc(alertId)
        .update({ seen: true });
      res.json({ message: 'Alert marked as seen' });
    } catch (err) {
      console.error('[Server] Mark alert seen error:', err.message);
      res.status(500).json({ error: 'Failed to update alert' });
    }
  }
);

// DELETE /watches/:watchId/alerts — clear all alerts for a watch (FR-5.3)
app.delete(
  '/watches/:watchId/alerts',
  watchLimiter,
  verifyFirebaseToken,
  async (req, res) => {
    const db = getFirestore();
    const { watchId } = req.params;

    try {
      const alertsRef = db
        .collection('users').doc(req.userId)
        .collection('watches').doc(watchId)
        .collection('alerts');

      const snap = await alertsRef.get();
      const batch = db.batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();

      res.json({ message: `Cleared ${snap.size} alert(s)`, watchId });
    } catch (err) {
      console.error('[Server] Clear alerts error:', err.message);
      res.status(500).json({ error: 'Failed to clear alerts' });
    }
  }
);

// ── FCM token registration ────────────────────────────────────────────────────
// POST /fcm-token
// Called by the Flutter app on startup and whenever the FCM token refreshes.
app.post('/fcm-token', watchLimiter, verifyFirebaseToken, async (req, res) => {
  const db = getFirestore();
  const { fcmToken } = req.body;

  if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.length > 500) {
    return res.status(400).json({ error: 'Missing or invalid fcmToken' });
  }

  try {
    await db.collection('users').doc(req.userId).set(
      {
        fcmToken,
        fcmTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    res.json({ message: 'FCM token updated' });
  } catch (err) {
    console.error('[Server] FCM token update error:', err.message);
    res.status(500).json({ error: 'Failed to update FCM token' });
  }
});

// ── Manual engine trigger (admin only) ───────────────────────────────────────
app.post('/trigger', requireTriggerSecret, async (req, res) => {
  console.log('[Server] Manual trigger received');
  res.json({ message: 'Engine triggered', time: new Date().toISOString() });
  runEngine();
});

// ── 404 fallback ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] CampSight running on port ${PORT}`);
  console.log(`[Server] Health: http://localhost:${PORT}/`);

  setTimeout(() => {
    console.log('[Server] Starting initial engine run...');
    runEngine();
  }, 10000);
});

// ── Engine runner with timing ─────────────────────────────────────────────────
async function runEngine() {
  const start = Date.now();
  global.totalRuns = (global.totalRuns || 0) + 1;
  global.lastEngineRun = new Date().toISOString();

  try {
    await runAlertEngine();
  } catch (err) {
    console.error('[Server] Engine error:', err.message);
  } finally {
    global.lastRunDurationMs = Date.now() - start;
  }
}

// ── Cron — every 60 seconds ───────────────────────────────────────────────────
cron.schedule('*/1 * * * *', () => {
  console.log(`[Cron] Tick at ${new Date().toISOString()}`);
  runEngine();
});

// ── Keep-alive ────────────────────────────────────────────────────────────────
// Render free tier spins down after 15 min of inactivity, killing the cron.
// This self-ping every 14 min keeps the service warm.
// RENDER_EXTERNAL_URL is set automatically by Render — no manual config needed.
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => {
    https
      .get(`${SELF_URL}/`, (res) => {
        res.resume(); // drain the response to free the socket
      })
      .on('error', (err) => {
        console.warn('[KeepAlive] Self-ping failed:', err.message);
      });
    console.log(`[KeepAlive] Pinged self at ${new Date().toISOString()}`);
  }, 14 * 60 * 1000);
  console.log('[KeepAlive] Self-ping enabled (every 14 min)');
} else {
  console.log('[KeepAlive] RENDER_EXTERNAL_URL not set — self-ping off (local dev is fine)');
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM — shutting down gracefully');
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection:', reason);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function serializeWatch(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    ...data,
    createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
    lastChecked: data.lastChecked?.toDate?.()?.toISOString() || null,
  };
}
