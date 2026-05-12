// alertEngine.js
//
// Core engine that:
//   1. Reads all active watches from Firestore (collectionGroup query)
//   2. Calls the scraper to check real Ontario Parks availability
//   3. Deduplicates alerts (one notification per same site + dates)
//   4. Writes alert documents to Firestore
//   5. Sends FCM push notifications to the user's device

const admin = require('firebase-admin');
const { getFirestore, getMessaging } = require('./firebase');
const { checkAvailability } = require('./scraper');

const BATCH_SIZE = 3;
const BATCH_DELAY = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Send FCM push notification ────────────────────────────────────────────────
async function sendPushNotification(fcmToken, alert) {
  if (!fcmToken) {
    console.log('[AlertEngine] No FCM token for user — skipping notification');
    return { success: false };
  }

  const messaging = getMessaging();

  const message = {
    token: fcmToken,
    notification: {
      title: '🏕️ Campsite Available!',
      body: `${alert.campgroundName} — ${alert.siteName} is open for your dates!`,
    },
    data: {
      watchId: alert.watchId,
      alertId: alert.alertId,
      campgroundName: alert.campgroundName,
      siteName: alert.siteName,
      checkIn: alert.checkIn,
      checkOut: alert.checkOut,
      bookingUrl: alert.bookingUrl,
      type: 'availability_alert',
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'campsight_alerts',
        priority: 'max',
        defaultSound: true,
        defaultVibrateTimings: true,
      },
    },
    apns: {
      payload: {
        aps: {
          alert: {
            title: '🏕️ Campsite Available!',
            body: `${alert.campgroundName} — ${alert.siteName} is available!`,
          },
          badge: 1,
          sound: 'default',
        },
      },
    },
  };

  try {
    const response = await messaging.send(message);
    console.log(`[AlertEngine] FCM sent: ${response}`);
    return { success: true };
  } catch (error) {
    console.error('[AlertEngine] FCM send error:', error.message);

    if (
      error.code === 'messaging/invalid-registration-token' ||
      error.code === 'messaging/registration-token-not-registered'
    ) {
      return { success: false, isInvalidToken: true };
    }

    return { success: false };
  }
}

// ── Deduplication check ────────────────────────────────────────────────────────
// Permanent dedupe: once an alert is written for the exact site + dates,
// do not send the same alert again.
async function hasAlreadyAlerted(watchRef, siteId, checkIn, checkOut) {
  try {
    const existingQuery = await watchRef
      .collection('alerts')
      .where('siteId', '==', siteId)
      .where('checkIn', '==', checkIn)
      .where('checkOut', '==', checkOut)
      .limit(1)
      .get();

    return !existingQuery.empty;
  } catch (err) {
    console.error('[AlertEngine] Dedup check failed:', err.message);

    // Safer choice: if dedupe check fails, do not send duplicate/spam alerts.
    return true;
  }
}

// ── Process a single watch ────────────────────────────────────────────────────
async function processWatch(watchDoc, userId) {
  const db = getFirestore();
  const watch = { id: watchDoc.id, ...watchDoc.data() };
  const watchRef = watchDoc.ref;

  console.log(`[AlertEngine] Processing watch ${watch.id} (${watch.campgroundName})`);

  try {
    const availableSites = await checkAvailability(watch);

    await watchRef.update({
      lastChecked: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (!Array.isArray(availableSites) || availableSites.length === 0) {
      console.log(`[AlertEngine] No availability for watch ${watch.id}`);
      return;
    }

    console.log(
      `[AlertEngine] 🎉 ${availableSites.length} site(s) available for watch ${watch.id}`
    );

    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      console.warn(`[AlertEngine] User ${userId} not found — skipping notification`);
      return;
    }

    const userData = userDoc.data();
    const fcmToken = userData.fcmToken || null;
    const globalNotificationsEnabled = userData.notificationsEnabled !== false;
    const watchNotificationsEnabled = watch.notificationsEnabled !== false;
    const shouldNotify =
      Boolean(fcmToken) &&
      globalNotificationsEnabled &&
      watchNotificationsEnabled;

    if (!shouldNotify) {
      console.log(
        `[AlertEngine] Notification skipped. token=${Boolean(fcmToken)}, global=${globalNotificationsEnabled}, watch=${watchNotificationsEnabled}`
      );
    }

    for (const site of availableSites) {
      const alreadyAlerted = await hasAlreadyAlerted(
        watchRef,
        site.siteId,
        site.checkIn,
        site.checkOut
      );

      if (alreadyAlerted) {
        console.log(
          `[AlertEngine] Skipping duplicate for site ${site.siteId} (${site.checkIn} → ${site.checkOut})`
        );
        continue;
      }

      const alertRef = await watchRef.collection('alerts').add({
        campgroundId: watch.campgroundId,
        campgroundName: watch.campgroundName,
        siteId: site.siteId,
        siteName: site.siteName,
        checkIn: site.checkIn,
        checkOut: site.checkOut,
        bookingUrl: site.bookingUrl,
        detectedAt: admin.firestore.FieldValue.serverTimestamp(),
        seen: false,
      });

      console.log(`[AlertEngine] Alert written: ${alertRef.id}`);

      if (shouldNotify) {
        const fcmResult = await sendPushNotification(fcmToken, {
          watchId: watch.id,
          alertId: alertRef.id,
          campgroundName: watch.campgroundName,
          siteName: site.siteName,
          checkIn: site.checkIn,
          checkOut: site.checkOut,
          bookingUrl: site.bookingUrl,
        });

        if (fcmResult?.isInvalidToken) {
          console.warn(`[AlertEngine] Removing stale FCM token for user ${userId}`);
          await userDoc.ref.update({
            fcmToken: admin.firestore.FieldValue.delete(),
          });
        }
      }
    }
  } catch (err) {
    console.error(`[AlertEngine] Error on watch ${watch.id}:`, err.message);
  }
}

// ── Main engine run ───────────────────────────────────────────────────────────
async function runAlertEngine() {
  const db = getFirestore();
  const startTime = Date.now();

  console.log('\n' + '─'.repeat(60));
  console.log(`[AlertEngine] Run started at ${new Date().toISOString()}`);

  try {
    const activeWatchesSnap = await db
      .collectionGroup('watches')
      .where('status', '==', 'active')
      .get();

    if (activeWatchesSnap.empty) {
      console.log('[AlertEngine] No active watches — nothing to do');
      return;
    }

    console.log(`[AlertEngine] Found ${activeWatchesSnap.docs.length} active watch(es)`);

    const watchDocs = activeWatchesSnap.docs;

    for (let i = 0; i < watchDocs.length; i += BATCH_SIZE) {
      const batch = watchDocs.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map((doc) => {
          const userId = doc.ref.parent.parent.id;
          return processWatch(doc, userId);
        })
      );

      if (i + BATCH_SIZE < watchDocs.length) {
        console.log(`[AlertEngine] Batch done — waiting ${BATCH_DELAY}ms before next batch`);
        await sleep(BATCH_DELAY);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[AlertEngine] Run complete in ${duration}s`);
  } catch (err) {
    console.error('[AlertEngine] Fatal error:', err.message);
  }
}

module.exports = { runAlertEngine };