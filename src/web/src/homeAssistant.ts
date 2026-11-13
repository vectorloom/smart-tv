import { useEffect, useState } from 'react';

export type HomeEntity = {
  id: string; domain: string; name: string; state: string; available: boolean; on: boolean; toggleable: boolean;
  brightness?: number | null; currentTemperature?: number | null; targetTemperature?: number | null;
  targetLow?: number | null; targetHigh?: number | null; hvacAction?: string | null; unit?: string | null;
};
export type HomeStatus = 'not-configured' | 'connecting' | 'live' | 'offline';
export type HomeSnapshot = { status: HomeStatus; message: string | null; entities: HomeEntity[] };
/** `connected`: this browser's event stream is open. `failed`: it has not managed to connect yet. */
export type HomeFeed = { snapshot: HomeSnapshot | null; connected: boolean; failed: boolean };

/** Reconnect delays after the browser gives up on the stream (EventSource retries brief drops itself). */
export const HOME_RETRY_DELAYS = [2_000, 5_000, 10_000, 30_000];
const STATUSES: readonly string[] = ['not-configured', 'connecting', 'live', 'offline'];

export function parseHomeSnapshot(data: unknown): HomeSnapshot | null {
  const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
  const optionalNumber = (value: unknown) => value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value));
  if (!object(data) || typeof data.status !== 'string' || !STATUSES.includes(data.status) ||
      !(data.message === null || data.message === undefined || typeof data.message === 'string') || !Array.isArray(data.entities) ||
      !data.entities.every(entity => object(entity) && typeof entity.id === 'string' && typeof entity.domain === 'string' &&
        typeof entity.name === 'string' && typeof entity.state === 'string' && typeof entity.available === 'boolean' &&
        typeof entity.on === 'boolean' && typeof entity.toggleable === 'boolean' &&
        optionalNumber(entity.brightness) && optionalNumber(entity.currentTemperature) && optionalNumber(entity.targetTemperature) &&
        optionalNumber(entity.targetLow) && optionalNumber(entity.targetHigh)))
    return null;
  return { status: data.status as HomeStatus, message: (data.message as string | null | undefined) ?? null, entities: data.entities as HomeEntity[] };
}

/**
 * Live Home Assistant state for the screen that's showing it. The server holds the Home Assistant
 * connection and token; this browser only follows /api/home/events, which sends a complete snapshot
 * on connect and after every change, so a reconnect never needs a separate fetch.
 */
export function useHomeAssistant(): HomeFeed {
  const [feed, setFeed] = useState<HomeFeed>({ snapshot: null, connected: false, failed: false });
  useEffect(() => {
    if (typeof EventSource === 'undefined') { setFeed(previous => ({ ...previous, failed: true })); return; }
    let disposed = false;
    let source: EventSource | null = null;
    let timer = 0;
    let failures = 0;
    const open = () => {
      if (disposed) return;
      source = new EventSource('/api/home/events');
      source.onopen = () => { failures = 0; setFeed(previous => ({ ...previous, connected: true, failed: false })); };
      source.addEventListener('snapshot', event => {
        let parsed: HomeSnapshot | null = null;
        try { parsed = parseHomeSnapshot(JSON.parse((event as MessageEvent<string>).data)); } catch { /* ignore a malformed event */ }
        if (parsed && !disposed) setFeed({ snapshot: parsed, connected: true, failed: false });
      });
      source.onerror = () => {
        if (disposed) return;
        setFeed(previous => ({ ...previous, connected: false, failed: previous.snapshot === null }));
        // CONNECTING means the browser is already retrying; CLOSED means it gave up (e.g. an HTTP error).
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          timer = window.setTimeout(open, HOME_RETRY_DELAYS[Math.min(failures++, HOME_RETRY_DELAYS.length - 1)]);
        }
      };
    };
    open();
    return () => { disposed = true; window.clearTimeout(timer); source?.close(); };
  }, []);
  return feed;
}

export async function toggleEntity(id: string): Promise<void> {
  const response = await fetch(`/api/home/entities/${encodeURIComponent(id)}/toggle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.message ?? 'Home Assistant could not switch that device. Try again.');
  }
}
