# CampSight Scraper — Backend

Real-time Ontario Parks campsite availability monitoring service.
Runs 24/7 on Render.com, checks availability every 60 seconds, and sends
FCM push notifications the moment a watched campsite opens up.

---

## How It Works

```
Every 60 seconds:
  1. Read all active watches from Firestore (collectionGroup query)
  2. For each watch → scrape Ontario Parks availability via Puppeteer
  3. If sites are available → write alert to Firestore
  4. Send FCM push notification to the user's device
  5. 30-minute deduplication prevents repeat alerts for the same site
```

---

## File Structure

```
campsight-scraper/
├── server.js          Entry point — Express API, cron job, keep-alive
├── alertEngine.js     Firestore reads/writes + FCM notifications
├── scraper.js         Puppeteer scraping (2 strategies + retry)
├── firebase.js        Firebase Admin SDK initialisation
├── cache.js           In-memory TTL cache for campground search results
├── firestore.rules    Firestore security rules — deploy to Firebase
├── package.json       Dependencies
├── .env.example       Environment variable template
└── README.md          This file
```

---

## API Reference

All endpoints return JSON. User-facing endpoints require a Firebase Auth ID token:

```
Authorization: Bearer <Firebase ID Token>
```

### Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | None | Health check — returns uptime |
| GET | `/status` | None | Engine run stats |

### Campground Search

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/campgrounds?q=<query>` | None | Search Ontario Parks campgrounds |

**Response:**
```json
{
  "results": [
    { "id": "12345", "name": "Algonquin PP - Canisbay Lake", "region": "East", "mapId": "67890" }
  ],
  "source": "live"
}
```

Results are cached in memory for 1 hour. `source` is `"cache"` or `"live"`.

### Watches

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/watches` | Firebase | List all watches for the user |
| POST | `/watches` | Firebase | Create a watch (enforces 3-limit) |
| PATCH | `/watches/:id` | Firebase | Update status/criteria |
| DELETE | `/watches/:id` | Firebase | Delete a watch |

**POST /watches body:**
```json
{
  "campgroundId": "12345",
  "campgroundName": "Algonquin PP - Canisbay Lake",
  "mapId": "67890",
  "checkIn": "2025-07-15",
  "checkOut": "2025-07-20",
  "siteNumber": "014"
}
```
`siteNumber` is optional — omit or leave empty to watch any available site.

**PATCH /watches/:id body** (any subset of these fields):
```json
{
  "status": "paused",
  "notificationsEnabled": false,
  "siteNumber": "015",
  "checkIn": "2025-07-16",
  "checkOut": "2025-07-21"
}
```

**409 response** when creating a 4th active watch:
```json
{
  "error": "Maximum of 3 active watches reached. Pause or delete a watch first.",
  "activeCount": 3
}
```

### Alert History

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/watches/:id/alerts` | Firebase | List alerts (newest first, max 50) |
| PATCH | `/watches/:id/alerts/:alertId` | Firebase | Mark alert as seen |
| DELETE | `/watches/:id/alerts` | Firebase | Clear all alerts for a watch |

**Alert object:**
```json
{
  "id": "abc123",
  "campgroundName": "Algonquin PP - Canisbay Lake",
  "siteName": "Site 014",
  "checkIn": "2025-07-15",
  "checkOut": "2025-07-20",
  "bookingUrl": "https://reservations.ontarioparks.ca/create-booking/results?...",
  "detectedAt": "2025-06-10T14:32:00.000Z",
  "seen": false
}
```

### FCM Token

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/fcm-token` | Firebase | Register or refresh the device FCM token |

**Body:**
```json
{ "fcmToken": "dVdT8..." }
```

Call this on app startup and whenever `FirebaseMessaging.onTokenRefresh` fires.

### Admin

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/trigger` | `x-trigger-secret` header | Manually run the alert engine |

```bash
curl -X POST https://your-app.onrender.com/trigger \
  -H "x-trigger-secret: YOUR_TRIGGER_SECRET"
```

---

## Deployment (Render.com)

### Step 1 — Get Firebase Service Account

1. Go to [Firebase Console](https://console.firebase.google.com) → your project
2. Gear icon → **Project Settings** → **Service Accounts** tab
3. Click **Generate New Private Key** → download the JSON file (keep it safe)

### Step 2 — Push Code to GitHub

```bash
git init
git add .
git commit -m "CampSight scraper v2"
git remote add origin https://github.com/YOUR_USERNAME/campsight-scraper
git push -u origin main
```

### Step 3 — Create a Render Web Service

1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect your GitHub repo
3. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free (or Starter for guaranteed uptime)

### Step 4 — Set Environment Variables

In your Render service → **Environment** tab:

| Key | Value |
|-----|-------|
| `FIREBASE_PROJECT_ID` | `campsight-2ff0e` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Full JSON contents as one line (see `.env.example`) |
| `TRIGGER_SECRET` | A strong random string (generate with command below) |

Generate a secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`PORT` and `RENDER_EXTERNAL_URL` are set automatically by Render — do not add them.

### Step 5 — Deploy Firestore Security Rules

```bash
firebase deploy --only firestore:rules
```

This blocks direct watch creation from the client and protects alert documents.

### Step 6 — Verify Deployment

After deploy, check the logs. You should see:

```
[Server] CampSight running on port 10000
[Firebase] Initialized successfully
[KeepAlive] Self-ping enabled (every 14 min)
[Server] Starting initial engine run...
[AlertEngine] Run started at 2025-06-10T...
[AlertEngine] Found 1 active watch(es)
[Scraper] Strategy 1 found 2 available site(s)
[AlertEngine] Alert written: abc123
[AlertEngine] FCM sent: projects/campsight-2ff0e/messages/xyz
[AlertEngine] Run complete in 14.2s
```

**Verify endpoints:**
```bash
# Health check
curl https://your-app.onrender.com/

# Search campgrounds
curl "https://your-app.onrender.com/campgrounds?q=algonquin"

# Manual trigger
curl -X POST https://your-app.onrender.com/trigger \
  -H "x-trigger-secret: YOUR_SECRET"
```

---

## Flutter Integration

### 1. Base URL

```dart
const String apiBase = 'https://your-app.onrender.com';
```

### 2. Auth Helper

```dart
Future<String> getIdToken() async {
  final user = FirebaseAuth.instance.currentUser;
  return await user!.getIdToken();
}

Future<Map<String, String>> authHeaders() async {
  return {
    'Authorization': 'Bearer ${await getIdToken()}',
    'Content-Type': 'application/json',
  };
}
```

### 3. Register FCM Token

Call this in your app initialisation and on `FirebaseMessaging.instance.onTokenRefresh`:

```dart
Future<void> registerFcmToken(String token) async {
  await http.post(
    Uri.parse('$apiBase/fcm-token'),
    headers: await authHeaders(),
    body: jsonEncode({'fcmToken': token}),
  );
}
```

### 4. Campground Search

```dart
Future<List<Campground>> searchCampgrounds(String query) async {
  final uri = Uri.parse('$apiBase/campgrounds').replace(
    queryParameters: {'q': query},
  );
  final response = await http.get(uri);
  final data = jsonDecode(response.body);
  return (data['results'] as List)
      .map((r) => Campground.fromJson(r))
      .toList();
}
```

### 5. Create a Watch

```dart
Future<void> createWatch(Watch watch) async {
  final response = await http.post(
    Uri.parse('$apiBase/watches'),
    headers: await authHeaders(),
    body: jsonEncode({
      'campgroundId': watch.campgroundId,
      'campgroundName': watch.campgroundName,
      'mapId': watch.mapId,
      'checkIn': watch.checkIn,  // 'YYYY-MM-DD'
      'checkOut': watch.checkOut,
      'siteNumber': watch.siteNumber ?? '',
    }),
  );

  if (response.statusCode == 409) {
    throw Exception('Maximum watches reached');
  }
  if (response.statusCode != 201) {
    throw Exception('Failed to create watch');
  }
}
```

### 6. Handle Push Notification Deep Link

In your FCM handler, extract the `watchId` from the notification data and navigate to that watch's detail screen:

```dart
FirebaseMessaging.onMessageOpenedApp.listen((message) {
  final watchId = message.data['watchId'];
  final alertId = message.data['alertId'];
  final bookingUrl = message.data['bookingUrl'];
  // Navigate to WatchDetailScreen(watchId: watchId)
  // Show the alert and a "Book Now" button opening bookingUrl
});
```

---

## Troubleshooting

**No alerts arriving:**
- Check Render logs for `[Scraper]` and `[AlertEngine]` lines
- Confirm `FIREBASE_SERVICE_ACCOUNT_JSON` is set correctly (valid JSON, no trailing newline)
- Check Firestore → your user → watches → confirm `status == "active"`
- Confirm `fcmToken` exists on the user document (call `/fcm-token` from the app)

**Puppeteer crashes:**
- Ontario Parks may have updated their website
- Check which strategy the logs say is running
- Strategy 2 (interception) is more resilient than direct API calls
- Reduce `BATCH_SIZE` in `alertEngine.js` to 1 if memory is tight

**`lastChecked` not updating on dashboard:**
- This was a bug in v1 — fixed in v2 using `FieldValue.serverTimestamp()`
- Redeploy the backend to get the fix

**Memory errors on free tier:**
- Free tier = 512 MB RAM
- Reduce `BATCH_SIZE` in `alertEngine.js` from 3 → 1
- Increase `BATCH_DELAY` from 5000 → 10000

**Free tier sleeping despite keep-alive:**
- The self-ping requires `RENDER_EXTERNAL_URL` to be set (Render sets this automatically)
- If it's still sleeping, upgrade to the Starter instance ($7/month) for guaranteed uptime

**Firestore permission denied on watch creation:**
- After deploying `firestore.rules`, watch creation from the Flutter app is blocked
- The app must call `POST /watches` on the backend instead of writing directly to Firestore
