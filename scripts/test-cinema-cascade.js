/**
 * Verify all 7 Cinema providers loaded + cascade routing works.
 */
const idx = require('/opt/vp-marketing/dist/services/cinema/cinema-providers/index');

console.log('=== Cinema providers loaded ===');
console.log('  generateStockShot:', typeof idx.generateStockShot);
console.log('  generateLumaShot:', typeof idx.generateLumaShot);
console.log('  generateWanShot:', typeof idx.generateWanShot);
console.log('  generateSeedanceShot:', typeof idx.generateSeedanceShot);
console.log('  generateHailuoShot:', typeof idx.generateHailuoShot);
console.log('  generateHedraShot:', typeof idx.generateHedraShot);
console.log('  generateVeoShot:', typeof idx.generateVeoShot);
console.log('  pickProvidersForShot:', typeof idx.pickProvidersForShot);
console.log('  getLumaQuotaStatus:', typeof idx.getLumaQuotaStatus);

// Cascade routing tests
console.log('\n=== Cascade routing tests ===');
const tests = [
  { shot_type: 'HERO_ESTABLISHING', has_character: false, duration_sec: 8, label: 'Hero no character' },
  { shot_type: 'HERO_ESTABLISHING', has_character: true, duration_sec: 8, label: 'Hero with character' },
  { shot_type: 'CHARACTER_SCENE', has_character: true, money_shot: true, duration_sec: 8, label: 'MONEY SHOT character' },
  { shot_type: 'CHARACTER_SCENE', has_character: true, money_shot: false, duration_sec: 8, label: 'Character non-money' },
  { shot_type: 'ATMOSPHERIC_BROLL', has_character: false, duration_sec: 6, label: 'Atmospheric b-roll' },
  { shot_type: 'TALKING_HEAD', has_character: true, duration_sec: 10, label: 'Talking head' },
];

for (const t of tests) {
  const cascade = idx.pickProvidersForShot(t);
  const cost = idx.estimateShotCostByContext(t);
  console.log(`  ${t.label.padEnd(28)} → [${cascade.join(',').padEnd(30)}] primary cost=$${(cost / 100).toFixed(2)}`);
}

// Luma quota check
console.log('\n=== Luma free tier quota ===');
const q = idx.getLumaQuotaStatus();
console.log(`  ${q.used}/${q.quota} used, ${q.remaining} remaining, available=${q.available}`);
