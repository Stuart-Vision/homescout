// The agent loop, driven by a scripted fake model instead of Gemini.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, type ModelClient, type ModelReply, type Turn } from '../lib/agent';
import { searchListings } from '../lib/tools';

/** Replies with the scripted answers in order, recording what it was sent. */
function scripted(...replies: ((turns: Turn[]) => ModelReply)[]): ModelClient & { calls: Turn[][] } {
  const calls: Turn[][] = [];
  return {
    calls,
    async next({ turns }) {
      calls.push(structuredClone(turns));
      const reply = replies[calls.length - 1];
      if (!reply) throw new Error('model called more times than scripted');
      return reply(turns);
    },
  };
}

const marinaSearch = { purpose: 'rent', communities: ['Dubai Marina'], bedrooms_min: 2, bedrooms_max: 2, price_max: 160000 };

test('calls a tool, feeds back the result, then answers with grounded ids', async () => {
  const expected = searchListings(marinaSearch as never) as { results: { id: string }[] };
  const ids = expected.results.slice(0, 2).map((r) => r.id);
  const model = scripted(
    () => ({ toolCalls: [{ name: 'search_listings', args: marinaSearch }] }),
    () => ({ text: `Two options: [${ids[0]}] and [${ids[1]}].` }),
  );

  const result = await runAgent('2-bed in Marina under 160k a year', model);

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].tool, 'search_listings');
  assert.deepEqual(result.citedIds, ids);
  assert.deepEqual(result.ungroundedIds, []);
  // The second call carried the tool result back to the model.
  const lastTurn = model.calls[1].at(-1)!;
  assert.equal(lastTurn.role, 'tool');
});

test('flags listing ids the model invented', async () => {
  const model = scripted(
    () => ({ toolCalls: [{ name: 'search_listings', args: marinaSearch }] }),
    () => ({ text: 'Try [HS-9999], it is perfect.' }),
  );
  const result = await runAgent('2-bed in Marina', model);
  assert.deepEqual(result.ungroundedIds, ['HS-9999']);
});

test('an answer with no tool calls cannot cite listings', async () => {
  const model = scripted(() => ({ text: 'I recommend [HS-1000].' }));
  const result = await runAgent('anything in Marina?', model);
  assert.deepEqual(result.ungroundedIds, ['HS-1000']);
});

test('invalid tool arguments are returned to the model so it can retry', async () => {
  const model = scripted(
    () => ({ toolCalls: [{ name: 'search_listings', args: { purpose: 'lease' } }] }),
    (turns) => {
      const last = turns.at(-1) as Extract<Turn, { role: 'tool' }>;
      assert.equal((last.results[0].result as { error: string }).error, 'Invalid arguments');
      return { toolCalls: [{ name: 'search_listings', args: { purpose: 'rent' } }] };
    },
    () => ({ text: 'Here are some rentals.' }),
  );
  const result = await runAgent('find me a rental', model);
  assert.equal(result.steps.length, 2);
  assert.equal(result.stoppedEarly, false);
});

test('runs several tools in one round', async () => {
  const model = scripted(
    () => ({ toolCalls: [
      { name: 'market_stats', args: { purpose: 'rent', communities: ['JVC', 'JLT'], bedrooms: 1 } },
      { name: 'mortgage_estimate', args: { price: 1_500_000 } },
    ] }),
    () => ({ text: 'Done.' }),
  );
  const result = await runAgent('compare JVC and JLT', model);
  assert.deepEqual(result.steps.map((s) => s.tool), ['market_stats', 'mortgage_estimate']);
});

test('stops after the step limit instead of looping forever', async () => {
  const loop = () => ({ toolCalls: [{ name: 'get_listing', args: { id: 'HS-1000' } }] });
  const model = scripted(loop, loop, loop);
  const result = await runAgent('loop', model, { maxSteps: 3 });
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.steps.length, 3);
});

test('previous turns are sent as history', async () => {
  const model = scripted(() => ({ text: 'Sure.' }));
  await runAgent('and in JVC?', model, { history: [{ role: 'user', text: 'studios in Marina' }, { role: 'model', text: 'Here you go.' }] });
  assert.deepEqual(model.calls[0].map((t) => t.role), ['user', 'model', 'user']);
});
