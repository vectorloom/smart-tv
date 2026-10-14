import { useState } from 'react';
import { type Command, useRemote } from './remote';

export function Remote() {
  const remote = useRemote('phone');
  const [code, setCode] = useState('');
  function button(command: Command, label: string, className = '') {
    return <button className={className} disabled={!remote.connected} onClick={() => remote.send({ type: 'command', command })}>{label}</button>;
  }
  return <main className="remote-page">
    <h1>TV remote</h1><p role="status" aria-live="polite">{remote.status}</p>
    {!remote.paired ? <form onSubmit={event => { event.preventDefault(); remote.send({ type: 'pair', code }); }}>
      <label htmlFor="pair-code">Pairing code from your TV</label>
      <input id="pair-code" autoComplete="off" inputMode="numeric" pattern="[0-9]{8}" maxLength={8} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} required />
      <button className="primary" disabled={!remote.ready || code.length !== 8}>Pair with TV</button>
    </form> : <>
      <div className="dpad" aria-label="Directional controls">
        {button('Up', '↑ Up', 'up')}{button('Left', '← Left', 'left')}{button('Select', 'Select', 'select primary')}{button('Right', 'Right →', 'right')}{button('Down', '↓ Down', 'down')}
      </div>
      <div className="remote-actions">{button('Back', 'Back')}{button('Home', 'Home')}{button('PlayPause', 'Play / Pause')}{button('Previous', 'Previous')}{button('Next', 'Next')}</div>
      <button disabled={!remote.ready} onClick={() => remote.send({ type: 'unpair' })}>Unpair phone</button>
    </>}
    <p className="remote-help">On the TV, choose “Pair phone”. Each code controls only that dashboard. Keep both pages open; after a page reload, pair again.</p>
  </main>;
}
