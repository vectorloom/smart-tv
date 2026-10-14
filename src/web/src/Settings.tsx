import { useEffect, useRef, useState } from 'react';

type Configuration = { revision: string; source: string; baseUrl: string; albumIds: string[]; keyConfigured: boolean; maskedKey: string | null };
type Album = { id: string; name: string; assetCount: number; thumbnailId: string | null };

export function Settings() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState('');
  const [replacement, setReplacement] = useState('');
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [albums, setAlbums] = useState<Album[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [albumError, setAlbumError] = useState('');
  const csrf = useRef('');
  async function request<T>(path: string, method = 'GET', body?: object): Promise<T> {
    const response = await fetch(`/api/admin/${path}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { 'X-CSRF': csrf.current }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      if (response.status === 401) { setAuthenticated(false); setConfiguration(null); setAlbums([]); setPassword(''); setReplacement(''); }
      const error = await response.json().catch(() => null);
      throw new Error(error?.message ?? (response.status === 429 ? 'Too many attempts. Wait one minute and retry.' : response.status === 401 ? 'Sign in to administrator settings.' : 'Request rejected. Refresh the page and sign in again.'));
    }
    return response.status === 204 ? undefined as T : response.json();
  }
  async function token() { csrf.current = (await request<{ token: string }>('csrf')).token; }
  async function load() {
    const data = await request<{ settings: Configuration; targets: string[] }>('settings');
    setConfiguration(data.settings); setTarget(data.settings.baseUrl); setSelected(data.settings.albumIds); setTargets(data.targets);
    setAlbumError('');
    try { setAlbums(await request<Album[]>('albums')); }
    catch (error) { setAlbums([]); setAlbumError(error instanceof Error ? error.message : 'Could not load albums.'); }
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await token(); await request('session');
        if (!active) return;
        setAuthenticated(true); await load();
      } catch (error) {
        if (active && error instanceof Error && error.message !== 'Sign in to administrator settings.') setMessage(error.message);
      }
      finally { if (active) setChecking(false); }
    })();
    return () => { active = false; };
  }, []);
  async function signIn(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    const submitted = password; setPassword('');
    try {
      await token(); await request('login', 'POST', { password: submitted });
      setAuthenticated(true); await token(); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  }
  async function save(importEnvironment = false) {
    if (!configuration) return;
    setBusy(true); setMessage('Validating connection and album access…');
    const submitted = replacement; setReplacement('');
    try {
      const saved = importEnvironment
        ? await request<Configuration>('import', 'POST', { revision: configuration.revision })
        : await request<Configuration>('settings', 'PUT', { revision: configuration.revision, baseUrl: target, albumIds: selected, replacementKey: submitted || null });
      setConfiguration(saved);
      await load(); setMessage('Settings saved. The TV uses the new configuration on subsequent requests.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Save failed. Existing settings were retained.'); }
    finally { setBusy(false); }
  }
  if (checking) return <main className="settings-page"><p role="status">Checking administrator session…</p></main>;
  return <main className="settings-page">
    <h1>Administrator settings</h1>
    <p>Immich connection and TV album selection</p>
    {message && <p role="status" className="notice">{message}</p>}
    {!authenticated ? <form onSubmit={signIn} className="settings-form">
      <label htmlFor="admin-password">Administrator passphrase</label>
      <input id="admin-password" type="password" autoComplete="off" value={password} maxLength={256} onChange={event => setPassword(event.target.value)} required />
      <button className="primary" disabled={busy}>Sign in</button>
      <p>No account yet, or lost your passphrase? Use the host-side administrator creation or recovery procedure.</p>
    </form> : <>
      <button disabled={busy} onClick={() => { void (async () => {
        try { await request('logout', 'POST'); setAuthenticated(false); setConfiguration(null); setAlbums([]); setReplacement(''); setMessage('Signed out.'); await token(); }
        catch (error) { setMessage(error instanceof Error ? error.message : 'Sign-out failed.'); }
      })(); }}>Sign out</button>
      {configuration && <form className="settings-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <p>Configuration source: <strong>{configuration.source}</strong>. API key: <strong>{configuration.keyConfigured ? 'Configured' : 'Not configured'}</strong>.</p>
        <label htmlFor="immich-target">Approved Immich connection</label>
        <select id="immich-target" value={target} disabled={busy} onChange={event => setTarget(event.target.value)}>
          {targets.map(url => <option key={url} value={url}>{url}</option>)}
        </select>
        <p>Saved API key identifier: <output aria-label="Saved API key identifier">{configuration.maskedKey ?? (configuration.keyConfigured ? 'Unavailable' : 'Not configured')}</output></p>
        <label htmlFor="immich-key">New or replacement API key</label>
        <input id="immich-key" type="password" autoComplete="off" spellCheck={false} value={replacement} maxLength={4096} disabled={busy} onChange={event => setReplacement(event.target.value)} />
        <p>Leave blank to retain the current key. Only album.read, asset.read, and asset.view are required. The complete saved key is never sent to this browser. Failed validation preserves existing settings.</p>
        <fieldset disabled={busy}>
          <legend>Albums shown on the TV ({selected.length} selected)</legend>
          <p>Includes albums shared with this Immich account. Selecting an album makes its photos available to anyone who can reach the TV dashboard.</p>
          {albumError && <p role="alert">{albumError} You can still enter a replacement key.</p>}
          <div className="settings-albums">{albums.map(album => <label className="settings-album" key={album.id}>
            <input type="checkbox" checked={selected.includes(album.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, album.id] : ids.filter(id => id !== album.id))} />
            <img loading="lazy" src={`/api/admin/albums/${encodeURIComponent(album.id)}/thumbnail`} alt="" onError={event => { event.currentTarget.hidden = true; }} />
            <span>{album.name}<small>{album.assetCount} items</small></span>
          </label>)}</div>
          {selected.filter(id => !albums.some(a => a.id === id)).map(id => <label className="settings-album" key={id}>
            <input type="checkbox" checked onChange={() => setSelected(ids => ids.filter(item => item !== id))} />
            <span>Previously selected album (currently unavailable)<small>{id}</small></span>
          </label>)}
          {!albums.length && !albumError && <p>No accessible albums.</p>}
          <button type="button" onClick={() => setSelected([])}>Clear selection</button>
          <p>When changing accounts, clear selections that the new account cannot access, save the key, then select its albums.</p>
        </fieldset>
        <button className="primary" disabled={busy}>{busy ? 'Validating…' : 'Validate and save'}</button>
        {configuration.source === 'environment' && <button type="button" disabled={busy} onClick={() => void save(true)}>Validate and import environment configuration</button>}
        <p>Import copies the server’s existing key and album IDs without sending the key to this browser. Future saves take precedence over environment variables.</p>
      </form>}
    </>}
  </main>;
}
