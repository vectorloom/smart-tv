import { useEffect, useState } from 'react';
import { PhoneIcon } from './icons';
import type { useRemote } from './remote';
import { STAGE_HEIGHT, STAGE_WIDTH, stageScale } from './Stage';
import { useWeather, weatherCredit } from './Weather';

type Remote = ReturnType<typeof useRemote>;

function useViewport() {
  const read = () => ({ width: document.documentElement.clientWidth || innerWidth, height: document.documentElement.clientHeight || innerHeight });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const update = () => setSize(read());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return size;
}

/** /preferences ("Settings" in the rail) — phone pairing and what this TV browser reports about its screen. */
export function PreferencesScreen({ remote }: { remote: Remote }) {
  const weather = useWeather();
  const viewport = useViewport();
  const scale = stageScale(viewport.width, viewport.height);
  return <main className="screen-page preferences-screen">
    <header className="screen-header"><h1>Settings</h1></header>
    <div className="settings-grid">
      <section className="card" aria-labelledby="remote-heading">
        <h2 className="label" id="remote-heading">Phone remote</h2>
        <p className="card-status">{remote.paired ? 'A phone is paired with this TV.' : remote.status}</p>
        {remote.code && !remote.paired ? <div className="pair-panel" role="status">
          <p>On your phone, open <strong>{location.host}/remote</strong> and enter</p>
          <p className="pair-code"><span>{remote.code.slice(0, 4)}</span><span>{remote.code.slice(4)}</span></p>
          <p className="muted">The code expires in two minutes.</p>
        </div> : <p className="muted">Pairing lets a phone on the same network act as this TV’s remote. It stays paired after reloads.</p>}
        <div className="card-actions">
          {remote.paired
            ? <button className="pill" data-focus-key="unpair" data-autofocus onClick={() => remote.send({ type: 'unpair' })}><PhoneIcon />Unpair phone</button>
            : <button className="pill pill-primary" data-focus-key="pair" data-autofocus disabled={!remote.ready} onClick={() => remote.send({ type: 'code' })}>
              <PhoneIcon />{remote.code ? 'New code' : 'Pair phone'}
            </button>}
        </div>
      </section>
      <section className="card" aria-labelledby="display-heading">
        <h2 className="label" id="display-heading">Display</h2>
        <dl className="facts">
          <div><dt>Browser viewport</dt><dd>{viewport.width} × {viewport.height}</dd></div>
          <div><dt>Layout</dt><dd>{STAGE_WIDTH} × {STAGE_HEIGHT} at {Math.round(scale * 100)}%</dd></div>
          <div><dt>Weather</dt><dd>{weather.forecast?.location ?? '—'}</dd></div>
        </dl>
        <p className="muted">{weatherCredit(weather)}. Albums and the Immich connection are managed in the administrator settings.</p>
      </section>
    </div>
  </main>;
}

export function PlaceholderScreen({ title, message }: { title: string; message: string }) {
  return <main className="screen-page placeholder-screen">
    <header className="screen-header"><h1>{title}</h1></header>
    <div className="notice"><p>{message}</p></div>
  </main>;
}
