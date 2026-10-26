// The agent loop: send the conversation to the model, run any tools it asks
// for, feed the results back, and repeat until it answers in text (or a step
// limit is hit). After the answer, a grounding check makes sure every listing
// id it mentions really came back from a tool, so it can't invent listings.

import { runTool, toolDeclarations } from './tools';

export const SYSTEM_PROMPT = `You are HomeScout, a property search assistant for Dubai.
Rules:
- Use the tools for every fact about listings, prices or areas. Never make up a listing, price or statistic.
- Turn every requirement the user states into a search filter: area, bedrooms (studio = 0; "2-bed" = exactly 2), budget, property type, furnished, amenities, sort order.
- Mention listings by their id in brackets, e.g. [HS-1042], with price in AED and size.
- Rent prices are yearly. If the user gives a monthly budget, multiply by 12 before searching.
- If a request is ambiguous (rent or buy?), make a sensible assumption and say what you assumed.
- If nothing matches, say so and suggest the closest alternative (another area or budget), checking it with a tool.
- Keep answers short: a one-line summary, then up to 5 listings as a list.
- Only help with property questions in Dubai; politely decline anything else.`;

export interface ToolCall { name: string; args: Record<string, unknown> }

/** What the agent needs from a model; Gemini implements it, tests use a fake. */
export interface ModelClient {
  next(input: { system: string; tools: ReturnType<typeof toolDeclarations>; turns: Turn[] }): Promise<ModelReply>;
}

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'model'; text?: string; toolCalls?: ToolCall[]; raw?: unknown }
  | { role: 'tool'; results: { name: string; result: unknown }[] };

export interface ModelReply { text?: string; toolCalls?: ToolCall[]; raw?: unknown }

export interface AgentStep { tool: string; args: Record<string, unknown>; result: unknown; ms: number }

export interface AgentResult {
  answer: string;
  steps: AgentStep[];
  citedIds: string[];
  ungroundedIds: string[];   // ids in the answer that no tool returned: a hallucination
  stoppedEarly: boolean;
}

const ID_PATTERN = /\bHS-\d{4}\b/g;

/** Every listing id that appears anywhere in a tool result. */
function idsIn(value: unknown): Set<string> {
  return new Set(JSON.stringify(value ?? null).match(ID_PATTERN) ?? []);
}

export async function runAgent(
  question: string,
  model: ModelClient,
  opts: { history?: Turn[]; maxSteps?: number } = {},
): Promise<AgentResult> {
  const maxSteps = opts.maxSteps ?? 5;
  const turns: Turn[] = [...(opts.history ?? []), { role: 'user', text: question }];
  const steps: AgentStep[] = [];
  const tools = toolDeclarations();

  for (let round = 0; round < maxSteps; round++) {
    const reply = await model.next({ system: SYSTEM_PROMPT, tools, turns });
    turns.push({ role: 'model', text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });

    if (!reply.toolCalls?.length) {
      return finish(reply.text ?? '', steps, false);
    }
    const results = reply.toolCalls.map((call) => {
      const started = Date.now();
      const result = runTool(call.name, call.args);
      steps.push({ tool: call.name, args: call.args, result, ms: Date.now() - started });
      return { name: call.name, result };
    });
    turns.push({ role: 'tool', results });
  }
  return finish('Sorry, I could not finish that search. Please try a simpler question.', steps, true);
}

function finish(answer: string, steps: AgentStep[], stoppedEarly: boolean): AgentResult {
  const seen = new Set(steps.flatMap((s) => [...idsIn(s.result)]));
  const cited = [...new Set(answer.match(ID_PATTERN) ?? [])];
  return { answer, steps, citedIds: cited, ungroundedIds: cited.filter((id) => !seen.has(id)), stoppedEarly };
}
