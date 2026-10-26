'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Listing } from '@/lib/listings';

interface Step { tool: string; args: Record<string, unknown>; ms: number }
interface Reply { answer: string; steps: Step[]; listings: Listing[]; ungroundedIds: string[] }
interface Message { role: 'user' | 'model'; text: string; reply?: Reply; error?: boolean }

const EXAMPLES = [
  '2-bed in Dubai Marina under AED 150k a year, furnished',
  'Compare 1-bed rents in JVC and JLT',
  'Cheapest villa to buy in Arabian Ranches, and the monthly mortgage',
  'Studio near the metro for 5,000 a month',
];

/** Light clean-up of the model's markdown: '* item' becomes a bullet, **bold** markers are dropped. */
const tidy = (text: string) => text.replace(/^\s*[*-]\s+/gm, '• ').replace(/\*\*(.+?)\*\*/g, '$1');

const aed = (n: number) => `AED ${n.toLocaleString('en-US')}`;

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  async function ask(text: string) {
    if (!text.trim() || busy) return;
    const history = messages.filter((m) => !m.error).slice(-6).map((m) => ({ role: m.role, text: m.text }));
    setMessages((m) => [...m, { role: 'user', text }]);
    setInput('');
    setBusy(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
      });
      const body = await res.json();
      setMessages((m) => [...m, res.ok
        ? { role: 'model', text: body.answer, reply: body }
        : { role: 'model', text: body.error ?? 'Something went wrong.', error: true }]);
    } catch {
      setMessages((m) => [...m, { role: 'model', text: 'Network error. Please try again.', error: true }]);
    } finally {
      setBusy(false);
    }
  }

  // A link like /?q=studio+in+JLT asks that question on load: handy for sharing a demo.
  const askedFromUrl = useRef(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q');
    if (q && !askedFromUrl.current) { askedFromUrl.current = true; ask(q); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => { e.preventDefault(); ask(input); };

  return (
    <main className="page">
      <header>
        <h1>HomeScout</h1>
        <p className="muted">Ask for Dubai homes in plain English. An AI agent searches the listings with tools and shows its work.</p>
      </header>

      {messages.length === 0 && (
        <div className="examples">
          {EXAMPLES.map((e) => <button key={e} onClick={() => ask(e)}>{e}</button>)}
        </div>
      )}

      <section className="chat" aria-live="polite">
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role} ${m.error ? 'error' : ''}`}>
            <div className="bubble">{m.role === 'model' ? tidy(m.text) : m.text}</div>
            {m.reply && m.reply.listings.length > 0 && (
              <div className="cards">
                {m.reply.listings.map((l) => (
                  <article key={l.id} className="card">
                    <div className="card-top"><strong>{l.title}</strong><span className="id">{l.id}</span></div>
                    <div className="price">{aed(l.price)}{l.purpose === 'rent' ? ' / year' : ''}</div>
                    <div className="muted">{l.bedrooms === 0 ? 'Studio' : `${l.bedrooms} bed`} · {l.bathrooms} bath · {l.sizeSqft.toLocaleString()} sq ft · {l.furnished ? 'Furnished' : 'Unfurnished'}</div>
                    {l.amenities.length > 0 && <div className="tags">{l.amenities.map((a) => <span key={a}>{a}</span>)}</div>}
                  </article>
                ))}
              </div>
            )}
            {m.reply && m.reply.steps.length > 0 && (
              <details className="trace">
                <summary>How the agent got this ({m.reply.steps.length} tool call{m.reply.steps.length > 1 ? 's' : ''})</summary>
                <ol>
                  {m.reply.steps.map((s, j) => (
                    <li key={j}><code>{s.tool}</code> <code className="args">{JSON.stringify(s.args)}</code> <span className="muted">{s.ms} ms</span></li>
                  ))}
                </ol>
              </details>
            )}
            {m.reply && m.reply.ungroundedIds.length > 0 && (
              <p className="warn">Check failed: {m.reply.ungroundedIds.join(', ')} did not come from a search, so it was not shown.</p>
            )}
          </div>
        ))}
        {busy && <div className="msg model"><div className="bubble muted">Searching…</div></div>}
      </section>

      <form onSubmit={submit} className="ask">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. 3-bed townhouse in Dubai Hills to buy" maxLength={500} aria-label="Your question" />
        <button type="submit" disabled={busy || !input.trim()}>Ask</button>
      </form>
      <footer className="muted">Sample data for a portfolio project: listings are synthetic and prices illustrative. Not affiliated with any property portal.</footer>
    </main>
  );
}
