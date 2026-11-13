import { useEffect, useRef, useState } from 'react';
import { type HomeEntity, type HomeFeed, toggleEntity, useHomeAssistant } from './homeAssistant';
import { BulbIcon, PowerIcon, ThermostatIcon } from './icons';

/** A pressed tile waits this long for Home Assistant to report the new state before giving up. */
export const PENDING_TIMEOUT = 8_000;
/** How long a failed toggle's message stays on screen. */
export const ERROR_VISIBLE = 6_000;

const GROUPS = [['light', 'Lights'], ['switch', 'Switches'], ['climate', 'Climate']] as const;

const degrees = (value: number | null | undefined, unit?: string | null) =>
  value === null || value === undefined ? '—' : `${Math.round(value)}${unit?.startsWith('°') ? '°' : unit ? ` ${unit}` : '°'}`;
const words = (value: string) => {
  const text = value === 'heat_cool' ? 'heat/cool' : value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

function statusLine(feed: HomeFeed): string {
  const snapshot = feed.snapshot;
  if (!snapshot) return feed.failed ? 'Home automation is unavailable. Retrying…' : 'Connecting…';
  if (!feed.connected) return 'Reconnecting… showing the last known state';
  if (snapshot.status === 'live') return 'Live from Home Assistant';
  return snapshot.message ?? (snapshot.status === 'connecting' ? 'Connecting to Home Assistant…' : 'Home Assistant is offline.');
}

function stateLabel(entity: HomeEntity, pending: boolean): string {
  if (pending) return entity.on ? 'Turning off…' : 'Turning on…';
  if (!entity.available) return 'Unavailable';
  if (!entity.on) return 'Off';
  return entity.brightness ? `On · ${entity.brightness}%` : 'On';
}

function DeviceTile({ entity, pending, autofocus, onPress }: { entity: HomeEntity; pending: boolean; autofocus: boolean; onPress: () => void }) {
  const Icon = entity.domain === 'light' ? BulbIcon : PowerIcon;
  return <li>
    <button className={`device-tile${entity.on ? ' is-on' : ''}${pending ? ' is-pending' : ''}`} data-focus-key={`device:${entity.id}`}
      data-autofocus={autofocus || undefined} aria-pressed={entity.on} disabled={!entity.available} onClick={onPress}>
      <Icon className="device-icon" />
      <span className="device-name">{entity.name}</span>
      <span className="device-state">{stateLabel(entity, pending)}</span>
    </button>
  </li>;
}

function ClimateCard({ entity }: { entity: HomeEntity }) {
  const target = entity.targetLow != null && entity.targetHigh != null
    ? `${degrees(entity.targetLow, entity.unit)}–${degrees(entity.targetHigh, entity.unit)}`
    : entity.targetTemperature != null ? degrees(entity.targetTemperature, entity.unit) : null;
  // Focusable though read-only: the remote scrolls by moving focus, so a card below the fold must be reachable.
  return <li className={`climate-card${entity.available ? '' : ' is-unavailable'}`} aria-label={entity.name} tabIndex={0} data-focus-key={`device:${entity.id}`}>
    <div className="climate-head"><ThermostatIcon className="device-icon" /><span className="device-name">{entity.name}</span></div>
    <p className="climate-now">{entity.available ? degrees(entity.currentTemperature, entity.unit) : '—'}</p>
    <p className="climate-mode">{entity.available
      ? [words(entity.state), entity.hvacAction && entity.hvacAction !== entity.state ? words(entity.hvacAction) : null].filter(Boolean).join(' · ')
      : 'Unavailable'}</p>
    {entity.available && target && <p className="climate-target">Set to {target}</p>}
  </li>;
}

/** /home-automation — the selected Home Assistant lights and switches (OK toggles) and climate readouts. */
export function HomeAutomationScreen() {
  const feed = useHomeAssistant();
  const entities = feed.snapshot?.entities ?? [];
  // id → the `on` value when pressed; cleared once Home Assistant reports a change, or after a timeout.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    setPending(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([id, was]) => entities.find(e => e.id === id)?.on === was));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    // Re-evaluated per snapshot; `entities` is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.snapshot]);
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(''), ERROR_VISIBLE);
    return () => window.clearTimeout(timer);
  }, [error]);
  useEffect(() => () => { for (const timer of timers.current.values()) window.clearTimeout(timer); }, []);

  const clear = (id: string) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setPending(({ [id]: _, ...rest }) => rest);
  };
  function press(entity: HomeEntity) {
    if (entity.id in pending) return;
    setError('');
    setPending(current => ({ ...current, [entity.id]: entity.on }));
    timers.current.set(entity.id, window.setTimeout(() => clear(entity.id), PENDING_TIMEOUT));
    toggleEntity(entity.id).catch((reason: unknown) => {
      clear(entity.id);
      setError(reason instanceof Error ? reason.message : 'Could not switch that device.');
    });
  }

  const loading = !feed.snapshot && !feed.failed;
  const stale = !!feed.snapshot && (!feed.connected || feed.snapshot.status !== 'live');
  const firstToggle = entities.find(e => e.toggleable && e.available)?.id;
  let body;
  if (!feed.snapshot) body = <div className="notice" aria-busy={loading}><p>{loading ? 'Connecting to Home Assistant…' : 'The TV could not reach its server. It keeps trying.'}</p></div>;
  else if (feed.snapshot.status === 'not-configured')
    body = <div className="notice"><h2>Home Assistant isn’t connected yet</h2><p>Connect it and choose devices in the administrator settings.</p></div>;
  else if (!entities.length)
    body = feed.snapshot.status === 'live'
      ? <div className="notice"><h2>No devices selected</h2><p>Choose lights, switches or thermostats in the administrator settings.</p></div>
      : <div className="notice" aria-busy={feed.snapshot.status === 'connecting'}><p>{statusLine(feed)}</p></div>;
  else body = GROUPS.map(([domain, title]) => {
    const items = entities.filter(entity => entity.domain === domain);
    if (!items.length) return null;
    return <section key={domain} className="device-group" aria-label={title}>
      <h2 className="label">{title}</h2>
      <ul className={domain === 'climate' ? 'climate-grid' : 'device-grid'}>
        {items.map(entity => domain === 'climate'
          ? <ClimateCard key={entity.id} entity={entity} />
          : <DeviceTile key={entity.id} entity={entity} pending={entity.id in pending} autofocus={entity.id === firstToggle} onPress={() => press(entity)} />)}
      </ul>
    </section>;
  });

  return <main className={`screen-page home-automation-screen${stale ? ' is-stale' : ''}`}>
    <header className="screen-header">
      <div>
        <h1>Home automation</h1>
        <p className="screen-sub" role="status">{statusLine(feed)}</p>
      </div>
    </header>
    {error && <div className="notice device-error" role="alert"><p>{error}</p></div>}
    {body}
  </main>;
}
