import { useEffect, useState } from 'react';

type View = { revision: string; configured: boolean; baseUrl: string; entityIds: string[]; tokenConfigured: boolean; maskedToken: string | null };
type EntityOption = { id: string; domain: string; name: string; state: string };
export type AdminRequest = <T>(path: string, method?: string, body?: object) => Promise<T>;

const GROUPS = [['light', 'Lights'], ['switch', 'Switches'], ['climate', 'Climate (shown, not controlled)']] as const;

/** Administrator section: Home Assistant destination, write-only token, and the devices the TV shows. */
export function HomeAssistantSettings({ request }: { request: AdminRequest }) {
  const [view, setView] = useState<View | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [replacement, setReplacement] = useState('');
  const [options, setOptions] = useState<EntityOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [entityError, setEntityError] = useState('');

  async function load() {
    const data = await request<{ settings: View; targets: string[] }>('home-assistant');
    setView(data.settings); setTargets(data.targets);
    setTarget(data.settings.configured ? data.settings.baseUrl : data.targets[0] ?? '');
    setSelected(data.settings.entityIds);
    setEntityError(''); setOptions([]);
    if (!data.settings.tokenConfigured) return;
    try { setOptions(await request<EntityOption[]>('home-assistant/entities')); }
    catch (error) { setEntityError(error instanceof Error ? error.message : 'Could not load devices.'); }
  }
  useEffect(() => {
    void load().catch(error => setMessage(error instanceof Error ? error.message : 'Could not load Home Assistant settings.'));
    // Loads once per sign-in; `request` is recreated on every render of the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    if (!view) return;
    setBusy(true); setMessage('Validating the Home Assistant connection and devices…');
    const submitted = replacement; setReplacement('');
    try {
      const saved = await request<View>('home-assistant', 'PUT', { revision: view.revision, baseUrl: target, replacementToken: submitted || null, entityIds: selected });
      setView(saved);
      await load();
      setMessage('Home Assistant settings saved. The TV picks up the change within 10 seconds.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Save failed. Existing settings were retained.'); }
    finally { setBusy(false); }
  }

  const toggle = (id: string, on: boolean) => setSelected(ids => on ? [...ids, id] : ids.filter(item => item !== id));
  if (!view) return message ? <p role="status" aria-label="Home Assistant status" className="notice">{message}</p> : null;
  return <section className="settings-section" aria-labelledby="ha-heading">
    <h2 id="ha-heading">Home Assistant</h2>
    {message && <p role="status" aria-label="Home Assistant status" className="notice">{message}</p>}
    {!targets.length ? <p>No Home Assistant destination is approved for this deployment. Set <code>SMART_TV_HA_TARGETS</code> and <code>SMART_TV_HA_ADDRESSES</code>, then restart.</p> :
    <form className="settings-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <p>Access token: <strong>{view.tokenConfigured ? 'Configured' : 'Not configured'}</strong>.</p>
      <label htmlFor="ha-target">Approved Home Assistant connection</label>
      <select id="ha-target" value={target} disabled={busy} onChange={event => setTarget(event.target.value)}>
        {targets.map(url => <option key={url} value={url}>{url}</option>)}
      </select>
      <p>Saved access token identifier: <output aria-label="Saved access token identifier">{view.maskedToken ?? (view.tokenConfigured ? 'Unavailable' : 'Not configured')}</output></p>
      <label htmlFor="ha-token">New or replacement access token</label>
      <input id="ha-token" type="password" autoComplete="off" spellCheck={false} value={replacement} maxLength={4096} disabled={busy} onChange={event => setReplacement(event.target.value)} />
      <p>Create a long-lived access token for a dedicated, non-administrator Home Assistant user. Leave blank to keep the current token. The complete token is never sent to this browser or the TV.</p>
      <fieldset disabled={busy || !view.tokenConfigured}>
        <legend>Devices shown on the TV ({selected.length} selected)</legend>
        <p>Anyone who can open the TV dashboard can switch the selected lights and switches.</p>
        {!view.tokenConfigured && <p>Save a token first, then choose devices.</p>}
        {entityError && <p role="alert">{entityError} You can still enter a replacement token.</p>}
        {GROUPS.map(([domain, title]) => {
          const items = options.filter(option => option.domain === domain);
          return items.length > 0 && <div key={domain} className="settings-devices">
            <h3>{title}</h3>
            {items.map(option => <label className="settings-device" key={option.id}>
              <input type="checkbox" checked={selected.includes(option.id)} onChange={event => toggle(option.id, event.target.checked)} />
              <span>{option.name}<small>{option.id} · {option.state}</small></span>
            </label>)}
          </div>;
        })}
        {selected.filter(id => !options.some(option => option.id === id)).map(id => <label className="settings-device" key={id}>
          <input type="checkbox" checked onChange={() => toggle(id, false)} />
          <span>Previously selected device (currently unavailable)<small>{id}</small></span>
        </label>)}
        {view.tokenConfigured && !options.length && !entityError && <p>No lights, switches or climate devices are visible to this user.</p>}
        <button type="button" onClick={() => setSelected([])}>Clear device selection</button>
      </fieldset>
      <button className="primary" disabled={busy}>{busy ? 'Validating…' : 'Validate and save Home Assistant'}</button>
    </form>}
  </section>;
}
