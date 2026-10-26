import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateListings, LISTINGS, resolveCommunity } from '../lib/listings';
import { getListing, marketStats, mortgageEstimate, runTool, searchListings, toolDeclarations } from '../lib/tools';

test('the dataset is the same on every run', () => {
  assert.deepEqual(generateListings(), LISTINGS);
  assert.equal(LISTINGS.length, 400);
  assert.equal(new Set(LISTINGS.map((l) => l.id)).size, 400);
});

test('community aliases resolve', () => {
  assert.equal(resolveCommunity('marina'), 'Dubai Marina');
  assert.equal(resolveCommunity('JVC'), 'Jumeirah Village Circle');
  assert.equal(resolveCommunity(' Downtown '), 'Downtown Dubai');
  assert.equal(resolveCommunity('Atlantis'), undefined);
});

test('search applies every filter', () => {
  const r = searchListings({ purpose: 'rent', communities: ['marina'], bedrooms_min: 2, bedrooms_max: 2, price_max: 200_000, limit: 10 });
  assert.ok('results' in r);
  assert.ok(r.results.length > 0);
  for (const l of r.results) {
    const full = LISTINGS.find((x) => x.id === l.id)!;
    assert.equal(full.purpose, 'rent');
    assert.equal(full.community, 'Dubai Marina');
    assert.equal(full.bedrooms, 2);
    assert.ok(full.price <= 200_000);
  }
  // Sorted cheapest first by default.
  const prices = r.results.map((l) => l.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});

test('amenities must all be present', () => {
  const r = searchListings({ purpose: 'buy', amenities: ['pool', 'gym'], limit: 10 });
  assert.ok('results' in r);
  for (const l of r.results) {
    const full = LISTINGS.find((x) => x.id === l.id)!;
    assert.ok(full.amenities.includes('pool') && full.amenities.includes('gym'));
  }
});

test('an unknown community returns an error the model can recover from', () => {
  const r = searchListings({ purpose: 'rent', communities: ['Atlantis'] });
  assert.ok('error' in r);
  assert.match(String(r.error), /Unknown community: Atlantis/);
  assert.ok((r as { known_communities?: string[] }).known_communities?.includes('Dubai Marina'));
});

test('market stats compute medians per community', () => {
  const data = [
    { id: 'HS-0001', title: '', purpose: 'rent' as const, type: 'apartment' as const, community: 'Dubai Marina', bedrooms: 1, bathrooms: 1, sizeSqft: 1000, price: 100_000, furnished: true, amenities: [], listedDaysAgo: 1 },
    { id: 'HS-0002', title: '', purpose: 'rent' as const, type: 'apartment' as const, community: 'Dubai Marina', bedrooms: 1, bathrooms: 1, sizeSqft: 1000, price: 120_000, furnished: true, amenities: [], listedDaysAgo: 1 },
    { id: 'HS-0003', title: '', purpose: 'rent' as const, type: 'apartment' as const, community: 'Dubai Marina', bedrooms: 1, bathrooms: 1, sizeSqft: 1000, price: 200_000, furnished: true, amenities: [], listedDaysAgo: 1 },
  ];
  const r = marketStats({ purpose: 'rent', communities: ['marina', 'jlt'] }, data) as { communities: Record<string, unknown>[] };
  assert.deepEqual(r.communities[0], { community: 'Dubai Marina', listings: 3, median_price: 120_000, min_price: 100_000, max_price: 200_000, median_price_per_sqft: 120 });
  assert.deepEqual(r.communities[1], { community: 'Jumeirah Lake Towers', listings: 0 });
});

test('mortgage estimate matches the standard formula', () => {
  // AED 1,000,000, 20% down, 25 years at 4.5%: loan 800,000 -> about 4,447 a month.
  const m = mortgageEstimate({ price: 1_000_000 });
  assert.equal(m.loan_amount, 800_000);
  assert.equal(m.monthly_payment, 4447);
  assert.equal(m.down_payment, 200_000);
});

test('runTool validates arguments instead of crashing', () => {
  assert.deepEqual(runTool('nope', {}), { error: 'Unknown tool nope' });
  const bad = runTool('search_listings', { purpose: 'lease', limit: 50 }) as { error: string; details: string[] };
  assert.equal(bad.error, 'Invalid arguments');
  assert.ok(bad.details.some((d) => d.startsWith('purpose')));
  assert.ok(bad.details.some((d) => d.startsWith('limit')));
  assert.deepEqual(runTool('get_listing', { id: 'hs-1000' }), getListing({ id: 'HS-1000' }));
});

test('tool declarations are generated from the schemas', () => {
  const decls = toolDeclarations();
  assert.deepEqual(decls.map((d) => d.name), ['search_listings', 'get_listing', 'market_stats', 'mortgage_estimate']);
  const search = decls[0].parametersJsonSchema as { required: string[]; properties: Record<string, unknown> };
  assert.deepEqual(search.required, ['purpose']);
  assert.ok('price_max' in search.properties);
  assert.ok(!('$schema' in decls[0].parametersJsonSchema));
});
