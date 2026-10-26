// Evaluates the agent against the real model: for each question, did it call the
// right tool with the right arguments, avoid inventing listings, and answer?
//
//   GEMINI_API_KEY=... npm run eval
//
// Writes a report to eval/results-<timestamp>.json and prints a summary.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { runAgent, type AgentResult, type AgentStep } from '../lib/agent';
import { geminiClient } from '../lib/gemini';
import { resolveCommunity } from '../lib/listings';

// Load .env.local when run outside Next.js.
if (!process.env.GEMINI_API_KEY && existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Check = (r: AgentResult) => string | null; // null = pass, string = why it failed

const calls = (r: AgentResult, tool: string) => r.steps.filter((s) => s.tool === tool);
const firstSearch = (r: AgentResult): Record<string, unknown> | undefined => calls(r, 'search_listings')[0]?.args;
const has = (args: Record<string, unknown> | undefined, key: string, pred: (v: unknown) => boolean, label: string): string | null =>
  args && pred(args[key]) ? null : `${label} (got ${JSON.stringify(args?.[key])})`;
// Compares community names after alias resolution: "JLT" and "Jumeirah Lake Towers" are both correct.
const listIncludes = (needle: string) => (v: unknown) =>
  Array.isArray(v) && v.some((x) => (resolveCommunity(String(x)) ?? String(x)).toLowerCase().includes(needle));

const CASES: { question: string; checks: Check[] }[] = [
  {
    question: '2-bed in Dubai Marina under AED 150k a year',
    checks: [
      (r) => has(firstSearch(r), 'purpose', (v) => v === 'rent', 'purpose should be rent'),
      (r) => has(firstSearch(r), 'communities', listIncludes('marina'), 'community should be Dubai Marina'),
      (r) => has(firstSearch(r), 'price_max', (v) => v === 150000, 'price_max should be 150000'),
      (r) => has(firstSearch(r), 'bedrooms_min', (v) => v === 2, 'bedrooms_min should be 2'),
    ],
  },
  {
    question: 'Studio in JLT for 5,000 a month',
    checks: [
      (r) => has(firstSearch(r), 'price_max', (v) => typeof v === 'number' && v >= 55000 && v <= 65000, 'monthly budget should become ~60000 a year'),
      (r) => has(firstSearch(r), 'bedrooms_max', (v) => v === 0, 'studio means bedrooms_max 0'),
      (r) => has(firstSearch(r), 'communities', listIncludes('jumeirah lake towers'), 'community should be JLT'),
    ],
  },
  {
    question: 'I want to buy a villa in Arabian Ranches with a pool',
    checks: [
      (r) => has(firstSearch(r), 'purpose', (v) => v === 'buy', 'purpose should be buy'),
      (r) => has(firstSearch(r), 'property_type', (v) => v === 'villa', 'type should be villa'),
      (r) => has(firstSearch(r), 'amenities', listIncludes('pool'), 'amenities should include pool'),
    ],
  },
  {
    question: 'Compare 1-bedroom rents in JVC and Business Bay',
    checks: [
      (r) => (calls(r, 'market_stats').length ? null : 'should use market_stats'),
      (r) => has(calls(r, 'market_stats')[0]?.args, 'bedrooms', (v) => v === 1, 'bedrooms should be 1'),
    ],
  },
  {
    question: 'What would the monthly mortgage be on a 2 million dirham apartment?',
    checks: [
      (r) => has(calls(r, 'mortgage_estimate')[0]?.args, 'price', (v) => v === 2000000, 'mortgage price should be 2000000'),
      (r) => (/\d/.test(r.answer) ? null : 'answer should include the monthly figure'),
    ],
  },
  {
    question: 'Cheapest furnished apartment for rent on the Palm',
    checks: [
      (r) => has(firstSearch(r), 'communities', listIncludes('palm'), 'community should be Palm Jumeirah'),
      (r) => has(firstSearch(r), 'furnished', (v) => v === true, 'furnished should be true'),
      (r) => has(firstSearch(r), 'sort', (v) => v === 'price_asc' || v === undefined, 'should sort cheapest first'),
    ],
  },
  {
    question: '4-bed apartment in International City under 20k a year',
    checks: [
      (r) => (calls(r, 'search_listings').length ? null : 'should search before saying nothing matches'),
      (r) => (/no |none|couldn.?t|not find|no matching|unable/i.test(r.answer) ? null : 'should say nothing matches'),
    ],
  },
  {
    question: 'Show me apartments in Atlantis City',
    checks: [
      (r) => (r.steps.length ? null : 'should try a tool'),
      (r) => (r.citedIds.length === 0 || r.ungroundedIds.length === 0 ? null : 'must not invent listings for an unknown area'),
    ],
  },
  {
    question: 'Write me a poem about football',
    checks: [
      (r) => (r.steps.length === 0 ? null : 'should not call tools for an off-topic request'),
      (r) => (/propert|home|dubai|help/i.test(r.answer) ? null : 'should redirect to property help'),
    ],
  },
  {
    question: 'Townhouse in Dubai Hills to rent, 3 bedrooms, newest first',
    checks: [
      (r) => has(firstSearch(r), 'property_type', (v) => v === 'townhouse', 'type should be townhouse'),
      (r) => has(firstSearch(r), 'sort', (v) => v === 'newest', 'sort should be newest'),
    ],
  },
];

// Every case also must not cite listings that no tool returned.
const GROUNDED: Check = (r) => (r.ungroundedIds.length ? `invented listing ids: ${r.ungroundedIds.join(', ')}` : null);

async function main() {
  const model = geminiClient();
  const rows: { question: string; passed: boolean; failures: string[]; tools: string[]; ms: number; answer: string; steps: AgentStep[] }[] = [];

  const errors: string[] = []; // the API itself failed (e.g. overloaded): not a quality result

  for (const c of CASES) {
    const started = Date.now();
    let result: AgentResult | undefined;
    // Google's API sometimes answers 503 "high demand"; wait and retry so that
    // capacity problems are not scored as agent mistakes.
    for (let attempt = 1; attempt <= 3 && !result; attempt++) {
      try {
        result = await runAgent(c.question, model);
      } catch (e) {
        if (attempt === 3) {
          errors.push(c.question);
          console.log(`ERROR ${c.question}\n      - API unavailable after 3 attempts: ${(e as Error).message.slice(0, 80)}`);
        } else {
          await sleep(15_000 * attempt);
        }
      }
    }
    if (!result) continue;
    const failures = [...c.checks, GROUNDED].map((check) => check(result)).filter((x): x is string => !!x);
    rows.push({ question: c.question, passed: failures.length === 0, failures, tools: result.steps.map((s) => s.tool), ms: Date.now() - started, answer: result.answer, steps: result.steps });
    console.log(`${failures.length ? 'FAIL' : 'PASS'}  ${c.question}${failures.length ? `\n      - ${failures.join('\n      - ')}` : ''}`);
    await sleep(2_000); // stay well inside the free tier's per-minute limit
  }

  const passed = rows.filter((r) => r.passed).length;
  console.log(`\n${passed}/${rows.length} scored cases passed${errors.length ? `, ${errors.length} not scored (API unavailable)` : ''} (model: ${process.env.GEMINI_MODEL || 'default'})`);
  mkdirSync('eval', { recursive: true });
  const file = `eval/results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify({ model: process.env.GEMINI_MODEL || 'default', passed, scored: rows.length, notScored: errors, rows }, null, 2));
  console.log(`Report: ${file}`);
  process.exit(passed === rows.length && errors.length === 0 ? 0 : 1);
}

main();
