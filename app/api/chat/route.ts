import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runAgent, type Turn } from '@/lib/agent';
import { geminiClient } from '@/lib/gemini';
import { LISTINGS } from '@/lib/listings';

// Allow time for retries when the model API is busy (Vercel's default can be shorter).
export const maxDuration = 60;

const Body = z.object({
  message: z.string().trim().min(1).max(500),
  history: z.array(z.object({ role: z.enum(['user', 'model']), text: z.string().max(4000) })).max(10).optional(),
});

// Simple per-IP limit so a public demo can't use up the API quota.
const WINDOW_MS = 10 * 60_000;
const MAX_REQUESTS = 20;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_REQUESTS;
}

export async function POST(request: Request) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (rateLimited(ip)) {
    return NextResponse.json({ error: 'Too many requests. Please wait a few minutes.' }, { status: 429 });
  }
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Send { message } of 1-500 characters.' }, { status: 400 });
  }
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: 'The AI model is not configured (GEMINI_API_KEY missing).' }, { status: 503 });
  }

  try {
    const history: Turn[] = (parsed.data.history ?? []).map((h) => ({ role: h.role, text: h.text }) as Turn);
    const result = await runAgent(parsed.data.message, geminiClient(), { history });
    const listings = result.citedIds
      .filter((id) => !result.ungroundedIds.includes(id))
      .map((id) => LISTINGS.find((l) => l.id === id))
      .filter(Boolean);
    return NextResponse.json({ ...result, listings });
  } catch (err) {
    console.error('agent failed', err);
    return NextResponse.json({ error: 'The assistant is unavailable right now. Please try again.' }, { status: 502 });
  }
}
