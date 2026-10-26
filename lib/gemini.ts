// ModelClient backed by Google's Gemini API (function calling).

import { GoogleGenAI, type Content } from '@google/genai';
import type { ModelClient, Turn } from './agent';

export const DEFAULT_MODEL = 'gemini-3.5-flash';
export const FALLBACK_MODEL = 'gemini-3.1-flash-lite';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 429 (rate limit) and 5xx (overloaded) are worth retrying; anything else is a real error. */
function retryable(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /"code":\s*(429|500|503)|\b(429|503)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand/i.test(msg);
}

export function geminiClient(
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_MODEL || DEFAULT_MODEL,
  fallback = process.env.GEMINI_FALLBACK_MODEL || FALLBACK_MODEL,
): ModelClient {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const ai = new GoogleGenAI({ apiKey });

  return {
    async next({ system, tools, turns }) {
      const request = (m: string) => ai.models.generateContent({
        model: m,
        contents: turns.map(toContent),
        config: {
          systemInstruction: system,
          tools: [{ functionDeclarations: tools }],
          temperature: 0.2, // consistent tool use matters more than creativity
        },
      });

      // Try the main model, retry it once after a pause, then fall back to a lighter
      // model (also retried once): Gemini returns 503 when a model is briefly overloaded.
      let response;
      try {
        response = await request(model);
      } catch (err) {
        if (!retryable(err)) throw err;
        await sleep(1500);
        try {
          response = await request(model);
        } catch (err2) {
          if (!retryable(err2) || fallback === model) throw err2;
          try {
            response = await request(fallback);
          } catch (err3) {
            if (!retryable(err3)) throw err3;
            await sleep(4000);
            response = await request(fallback);
          }
        }
      }

      const calls = response.functionCalls ?? [];
      return {
        text: calls.length ? undefined : response.text ?? '',
        toolCalls: calls.map((c) => ({ name: c.name ?? '', args: (c.args ?? {}) as Record<string, unknown> })),
        // The model's own message is sent back unchanged on the next turn, so the
        // reasoning data Gemini attaches to tool calls (thought signatures) is kept.
        raw: response.candidates?.[0]?.content,
      };
    },
  };
}

function toContent(turn: Turn): Content {
  switch (turn.role) {
    case 'user':
      return { role: 'user', parts: [{ text: turn.text }] };
    case 'model':
      if (turn.raw) return turn.raw as Content;
      return {
        role: 'model',
        parts: turn.toolCalls?.length
          ? turn.toolCalls.map((c) => ({ functionCall: { name: c.name, args: c.args } }))
          : [{ text: turn.text ?? '' }],
      };
    case 'tool':
      return {
        role: 'user',
        parts: turn.results.map((r) => ({ functionResponse: { name: r.name, response: { result: r.result } } })),
      };
  }
}
