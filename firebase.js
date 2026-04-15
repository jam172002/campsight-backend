// firebase.js
// Initializes Firebase Admin SDK using the service account stored as an env var.

const admin = require('firebase-admin');

let initialized = false;

function initFirebase() {
  if (initialized) return;

  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID || 'campsight-2ff0e',
    });

    initialized = true;
    console.log('[Firebase] Initialized successfully');
  } catch (err) {
    console.error('[Firebase] Failed to initialize:', err.message);
    console.error('[Firebase] Make sure FIREBASE_SERVICE_ACCOUNT_JSON is set correctly');
    process.exit(1);
  }
}

function getFirestore() {
  return admin.firestore();
}

function getMessaging() {
  return admin.messaging();
}

module.exports = { initFirebase, getFirestore, getMessaging };
