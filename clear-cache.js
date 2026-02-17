// clear-cache.js
const { clearUserMetaCache } = require('./src/api/middleware');

// Clear cache for specific user
clearUserMetaCache('testuser_4_1771329474298');
console.log('✅ Cache cleared for user');

// Or clear entire cache
// clearUserMetaCache();
// console.log('✅ All cache cleared');