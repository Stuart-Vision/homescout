// The tools the AI agent can call. Each tool has a Zod schema (validates the
// model's arguments and generates the JSON schema the model sees) and a plain
// TypeScript implementation over the listings data. Tools never throw: bad
// input comes back as { error } so the model can correct itself.

import { z } from 'zod';
import { COMMUNITIES, LISTINGS, resolveCommunity, type Listing } from './listings';

const purpose = z.enum(['rent', 'buy']).describe('"rent" for yearly rentals, "buy" for properties for sale');
const propertyType = z.enum(['apartment', 'villa', 'townhouse']);

export const SearchArgs = z.object({
  purpose,
  communities: z.array(z.string()).max(5).optional().describe('Community names, e.g. ["Dubai Marina", "JVC"]'),
  property_type: propertyType.optional(),
  bedrooms_min: z.number().int().min(0).max(7).optional().describe('Minimum bedrooms. A studio is 0 bedrooms: for a studio set bedrooms_min 0 and bedrooms_max 0'),
  bedrooms_max: z.number().int().min(0).max(7).optional().describe('Maximum bedrooms. For an exact count ("2-bed") set min and max to the same number'),
  price_min: z.number().min(0).optional().describe('AED; yearly rent when renting'),
  price_max: z.number().min(0).optional().describe('AED; yearly rent when renting'),
  furnished: z.boolean().optional(),
  amenities: z.array(z.string()).max(5).optional().describe('e.g. ["pool", "sea view", "near metro"]'),
  sort: z.enum(['price_asc', 'price_desc', 'newest', 'price_per_sqft_asc']).optional(),
  limit: z.number().int().min(1).max(10).optional().describe('Default 5'),
});

export const ListingArgs = z.object({ id: z.string().describe('Listing id, e.g. HS-1042') });

export const MarketStatsArgs = z.object({
  purpose,
  communities: z.array(z.string()).min(1).max(5),
  bedrooms: z.number().int().min(0).max(7).optional(),
  property_type: propertyType.optional(),
});

export const MortgageArgs = z.object({
  price: z.number().positive().max(100_000_000).describe('Property price in AED'),
  down_payment_pct: z.number().min(20).max(90).optional().describe('At least 20% for most buyers; default 20'),
  years: z.number().int().min(5).max(25).optional().describe('Default 25'),
  annual_rate_pct: z.number().min(0.5).max(15).optional().describe('Default 4.5'),
});

type CompactListing = Pick<Listing, 'id' | 'title' | 'community' | 'bedrooms' | 'sizeSqft' | 'price' | 'furnished'> & { pricePerSqft: number };

const compact = (l: Listing): CompactListing => ({
  id: l.id, title: l.title, community: l.community, bedrooms: l.bedrooms, sizeSqft: l.sizeSqft,
  price: l.price, furnished: l.furnished, pricePerSqft: Math.round(l.price / l.sizeSqft),
});

/** Returned instead of throwing, so the model can read it and correct itself. */
export interface ToolError { error: string; known_communities?: string[]; details?: string[] }

function resolveAll(names: string[] | undefined): { names?: string[]; error?: ToolError } {
  if (!names?.length) return {};
  const resolved = names.map((n) => [n, resolveCommunity(n)] as const);
  const unknown = resolved.filter(([, r]) => !r).map(([n]) => n);
  if (unknown.length) {
    return { error: { error: `Unknown community: ${unknown.join(', ')}`, known_communities: COMMUNITIES.map((c) => c.name) } };
  }
  return { names: resolved.map(([, r]) => r!) };
}

export function searchListings(args: z.infer<typeof SearchArgs>, data: Listing[] = LISTINGS): ToolError | { total_matches: number; results: CompactListing[] } {
  const communities = resolveAll(args.communities);
  if (communities.error) return communities.error;
  const wanted = (args.amenities ?? []).map((a) => a.toLowerCase());

  const matches = data.filter((l) =>
    l.purpose === args.purpose &&
    (!communities.names || communities.names.includes(l.community)) &&
    (!args.property_type || l.type === args.property_type) &&
    (args.bedrooms_min === undefined || l.bedrooms >= args.bedrooms_min) &&
    (args.bedrooms_max === undefined || l.bedrooms <= args.bedrooms_max) &&
    (args.price_min === undefined || l.price >= args.price_min) &&
    (args.price_max === undefined || l.price <= args.price_max) &&
    (args.furnished === undefined || l.furnished === args.furnished) &&
    wanted.every((a) => l.amenities.includes(a)));

  const sorters: Record<string, (a: Listing, b: Listing) => number> = {
    price_asc: (a, b) => a.price - b.price,
    price_desc: (a, b) => b.price - a.price,
    newest: (a, b) => a.listedDaysAgo - b.listedDaysAgo,
    price_per_sqft_asc: (a, b) => a.price / a.sizeSqft - b.price / b.sizeSqft,
  };
  matches.sort(sorters[args.sort ?? 'price_asc']);
  return { total_matches: matches.length, results: matches.slice(0, args.limit ?? 5).map(compact) };
}

export function getListing({ id }: z.infer<typeof ListingArgs>, data: Listing[] = LISTINGS) {
  const listing = data.find((l) => l.id.toLowerCase() === id.trim().toLowerCase());
  return listing ? { listing } : { error: `No listing with id ${id}` };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

export function marketStats(args: z.infer<typeof MarketStatsArgs>, data: Listing[] = LISTINGS) {
  const communities = resolveAll(args.communities);
  if (communities.error) return communities.error;
  return {
    purpose: args.purpose,
    bedrooms: args.bedrooms ?? 'any',
    communities: communities.names!.map((name) => {
      const ls = data.filter((l) => l.community === name && l.purpose === args.purpose &&
        (args.bedrooms === undefined || l.bedrooms === args.bedrooms) &&
        (!args.property_type || l.type === args.property_type));
      if (!ls.length) return { community: name, listings: 0 };
      return {
        community: name,
        listings: ls.length,
        median_price: median(ls.map((l) => l.price)),
        min_price: Math.min(...ls.map((l) => l.price)),
        max_price: Math.max(...ls.map((l) => l.price)),
        median_price_per_sqft: median(ls.map((l) => Math.round(l.price / l.sizeSqft))),
      };
    }),
  };
}

/** Standard amortising loan: monthly = P·r / (1 − (1+r)^−n). */
export function mortgageEstimate(args: z.infer<typeof MortgageArgs>) {
  const downPct = args.down_payment_pct ?? 20;
  const years = args.years ?? 25;
  const ratePct = args.annual_rate_pct ?? 4.5;
  const loan = args.price * (1 - downPct / 100);
  const r = ratePct / 100 / 12;
  const n = years * 12;
  const monthly = r === 0 ? loan / n : (loan * r) / (1 - (1 + r) ** -n);
  return {
    price: args.price,
    down_payment: Math.round(args.price * (downPct / 100)),
    loan_amount: Math.round(loan),
    monthly_payment: Math.round(monthly),
    total_interest: Math.round(monthly * n - loan),
    assumptions: { down_payment_pct: downPct, years, annual_rate_pct: ratePct },
    note: 'Estimate only. Excludes fees such as the 4% DLD transfer fee and agency commission.',
  };
}

interface ToolDef {
  description: string;
  schema: z.ZodType;
  run: (args: never) => unknown;
}

export const TOOLS: Record<string, ToolDef> = {
  search_listings: {
    description: 'Search property listings in Dubai. Use for any request to find homes. Returns the total number of matches and the top results.',
    schema: SearchArgs,
    run: searchListings as (a: never) => unknown,
  },
  get_listing: {
    description: 'Get every detail of one listing (bathrooms, amenities, days on market) by its id.',
    schema: ListingArgs,
    run: getListing as (a: never) => unknown,
  },
  market_stats: {
    description: 'Median, minimum and maximum prices and median price per sq ft for communities. Use to compare areas or judge whether a price is fair.',
    schema: MarketStatsArgs,
    run: marketStats as (a: never) => unknown,
  },
  mortgage_estimate: {
    description: 'Estimate monthly mortgage payments for buying a property.',
    schema: MortgageArgs,
    run: mortgageEstimate as (a: never) => unknown,
  },
};

/** JSON schemas the model sees, generated from the Zod schemas (one source of truth). */
export function toolDeclarations() {
  return Object.entries(TOOLS).map(([name, t]) => {
    const { $schema: _ignored, ...parametersJsonSchema } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return { name, description: t.description, parametersJsonSchema };
  });
}

/** Validates the model's arguments and runs the tool. Never throws. */
export function runTool(name: string, rawArgs: unknown): unknown {
  const tool = TOOLS[name];
  if (!tool) return { error: `Unknown tool ${name}` };
  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { error: 'Invalid arguments', details: parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`) };
  }
  return tool.run(parsed.data as never);
}
