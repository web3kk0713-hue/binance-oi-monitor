import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Execute the shipped worker handler; this is not a browser permission/delivery test.
const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const scope = 'https://example.test/binance-oi-monitor/';
async function click(url: string, withClient = true, data: Record<string, unknown> = {}) {
  const handlers = new Map<string, (event: unknown) => void>(), focus = vi.fn(async () => {}), postMessage = vi.fn(), openWindow = vi.fn(async () => {});
  const client = { url: scope, focus, postMessage };
  const self = { location: { origin: 'https://example.test' }, registration: { scope },
    clients: { matchAll: vi.fn(async () => withClient ? [client] : []), openWindow }, addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) };
  runInNewContext(source, { self, URL });
  let task: Promise<unknown> | null = null;
  handlers.get('notificationclick')!({ notification: { data: { url, ...data }, close: vi.fn() }, waitUntil: (value: Promise<unknown>) => { task = value; } });
  if (task) await task;
  return { postMessage, openWindow, focus };
}
describe('notification destination', () => {
  it('focuses existing app directly on entry observations', async () => {
    const result = await click(`${scope}?view=risks&risk=entry`);
    expect(result.postMessage).toHaveBeenCalledWith({ type: 'select-entry-plans' }); expect(result.focus).toHaveBeenCalledOnce();
  });
  it('retains the positions destination', async () => {
    expect((await click(`${scope}?view=positions`)).postMessage).toHaveBeenCalledWith({ type: 'select-positions' });
  });
  it('opens the full entry deep link if no app client is open', async () => {
    const url = `${scope}?view=risks&risk=entry`, result = await click(url, false);
    expect(result.openWindow).toHaveBeenCalledWith(url); expect(result.postMessage).not.toHaveBeenCalled();
  });
  it.each(['https://evil.test/?view=risks&risk=entry', 'https://example.test/other/?view=risks&risk=entry'])('never follows an out-of-scope target %s', async url => {
    const result = await click(url); expect(result.focus).not.toHaveBeenCalled(); expect(result.openWindow).not.toHaveBeenCalled();
  });
  it('keeps order-flow notification routing', async () => {
    const result = await click(scope, true, { marketKey: 'futures:BTCUSDT', eventId: 'a' });
    expect(result.postMessage).toHaveBeenCalledWith({ type: 'select-flow-event', marketKey: 'futures:BTCUSDT', eventId: 'a' });
  });
});
