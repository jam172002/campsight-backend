// cache.js
//
// Simple in-memory TTL cache.
//
// Used to avoid spinning up Puppeteer for repeated campground search queries
// (e.g. the user types "algo" then "algon" then "algonquin" in quick succession).
// Results are cached per-query for 1 hour by default.
//
// This is process-local — cache clears on restart, which is fine for this use case.

const _store = new Map();

// Retrieve a cached value. Returns null if missing or expired.
function get(key) {
  const entry = _store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _store.delete(key);
    return null;
  }
  return entry.value;
}

// Store a value with a TTL in milliseconds. Default: 1 hour.
function set(key, value, ttlMs = 60 * 60 * 1000) {
  _store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// Delete a specific key.
function del(key) {
  _store.delete(key);
}

// Clear the entire cache (useful in tests or after a scraper update).
function clear() {
  _store.clear();
}

// Returns the number of currently live entries (for debugging).
function size() {
  const now = Date.now();
  let live = 0;
  for (const entry of _store.values()) {
    if (entry.expiresAt > now) live++;
  }
  return live;
}

module.exports = { get, set, del, clear, size };
