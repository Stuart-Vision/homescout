// Synthetic Dubai property listings. Generated from a fixed seed so every run,
// test and evaluation sees exactly the same data. Prices are illustrative only.

export type Purpose = 'rent' | 'buy';
export type PropertyType = 'apartment' | 'villa' | 'townhouse';

export interface Listing {
  id: string;            // e.g. HS-1042
  title: string;
  purpose: Purpose;
  type: PropertyType;
  community: string;
  bedrooms: number;      // 0 = studio
  bathrooms: number;
  sizeSqft: number;
  price: number;         // AED: yearly rent, or sale price
  furnished: boolean;
  amenities: string[];
  listedDaysAgo: number;
}

interface Community {
  name: string;
  aliases: string[];
  types: PropertyType[];
  rentPerSqft: number;   // AED per sq ft per year
  salePerSqft: number;   // AED per sq ft
}

export const COMMUNITIES: Community[] = [
  { name: 'Dubai Marina', aliases: ['marina'], types: ['apartment'], rentPerSqft: 130, salePerSqft: 2000 },
  { name: 'Downtown Dubai', aliases: ['downtown', 'burj khalifa area'], types: ['apartment'], rentPerSqft: 150, salePerSqft: 2600 },
  { name: 'Business Bay', aliases: ['business bay', 'bb'], types: ['apartment'], rentPerSqft: 120, salePerSqft: 1900 },
  { name: 'Jumeirah Lake Towers', aliases: ['jlt'], types: ['apartment'], rentPerSqft: 100, salePerSqft: 1500 },
  { name: 'Jumeirah Village Circle', aliases: ['jvc'], types: ['apartment', 'townhouse'], rentPerSqft: 85, salePerSqft: 1100 },
  { name: 'Al Barsha', aliases: ['barsha'], types: ['apartment', 'villa'], rentPerSqft: 80, salePerSqft: 1200 },
  { name: 'Dubai Hills Estate', aliases: ['dubai hills', 'hills'], types: ['apartment', 'villa', 'townhouse'], rentPerSqft: 120, salePerSqft: 2100 },
  { name: 'Arabian Ranches', aliases: ['ranches'], types: ['villa', 'townhouse'], rentPerSqft: 90, salePerSqft: 1600 },
  { name: 'Palm Jumeirah', aliases: ['palm', 'the palm'], types: ['apartment', 'villa'], rentPerSqft: 200, salePerSqft: 3500 },
  { name: 'International City', aliases: ['intl city'], types: ['apartment'], rentPerSqft: 50, salePerSqft: 700 },
];

const AMENITIES = ['pool', 'gym', 'parking', 'balcony', 'sea view', 'maid room', 'pets allowed', 'near metro', 'garden', 'concierge'];

const SIZES: Record<PropertyType, [beds: number, min: number, max: number][]> = {
  apartment: [[0, 400, 550], [1, 700, 900], [2, 1100, 1400], [3, 1500, 2000]],
  townhouse: [[2, 1800, 2200], [3, 2200, 2700], [4, 2700, 3200]],
  villa: [[3, 2500, 3500], [4, 3500, 4500], [5, 4500, 6500]],
};

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateListings(count = 400, seed = 2026): Listing[] {
  const rand = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const between = (a: number, b: number) => a + rand() * (b - a);
  const listings: Listing[] = [];

  for (let i = 0; i < count; i++) {
    const c = pick(COMMUNITIES);
    const type = pick(c.types);
    const [bedrooms, minSize, maxSize] = pick(SIZES[type]);
    const sizeSqft = Math.round(between(minSize, maxSize) / 10) * 10;
    const purpose: Purpose = rand() < 0.6 ? 'rent' : 'buy';
    const perSqft = (purpose === 'rent' ? c.rentPerSqft : c.salePerSqft) * between(0.85, 1.15);
    const rounding = purpose === 'rent' ? 1_000 : 10_000;
    const price = Math.round((sizeSqft * perSqft) / rounding) * rounding;
    const amenities = AMENITIES.filter(() => rand() < 0.35);
    if (type !== 'apartment' && !amenities.includes('garden')) amenities.push('garden');
    const label = bedrooms === 0 ? 'Studio' : `${bedrooms}-bed`;
    listings.push({
      id: `HS-${1000 + i}`,
      title: `${label} ${type} in ${c.name}`,
      purpose,
      type,
      community: c.name,
      bedrooms,
      bathrooms: Math.max(1, bedrooms + (rand() < 0.5 ? 0 : 1)),
      sizeSqft,
      price,
      furnished: rand() < 0.45,
      amenities,
      listedDaysAgo: Math.floor(between(0, 60)),
    });
  }
  return listings;
}

export const LISTINGS: Listing[] = generateListings();

/** Maps "marina", "JVC", "dubai marina" ... to the canonical community name. */
export function resolveCommunity(input: string): string | undefined {
  const q = input.trim().toLowerCase();
  return COMMUNITIES.find((c) => c.name.toLowerCase() === q || c.aliases.includes(q))?.name;
}
