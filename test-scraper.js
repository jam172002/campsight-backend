// test-scraper.js
//
// Quick local test for the scraper — runs without starting the full server.
// No Firebase, no cron, no auth required.
//
// Usage:
//   node test-scraper.js
//   node test-scraper.js "Killbear"
//   node test-scraper.js "Algonquin"

const { searchCampgrounds } = require('./scraper');

const query = process.argv[2] || 'Algonquin';

console.log(`\n🔍 Testing searchCampgrounds("${query}")\n`);

searchCampgrounds(query)
  .then((results) => {
    if (results.length === 0) {
      console.log('❌ No results returned — check scraper logs above for errors');
    } else {
      console.log(`✅ ${results.length} result(s):\n`);
      results.forEach((r) =>
        console.log(`  • ${r.name} [${r.region}]  id=${r.id}  mapId=${r.mapId}`)
      );
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });
