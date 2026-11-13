import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { HOME_RETRY_DELAYS, parseHomeSnapshot, type HomeEntity, type HomeSnapshot } from './homeAssistant';
import { HomeAutomationScreen, PENDING_TIMEOUT } from './HomeAutomationScreen';

vi.mock('./remote', () => ({ useRemote: () => ({ ready: true, status: 'No phone connected', connected: false, paired: false, code: '', send: vi.fn() }) }));
vi.mock('./api', async original => ({
  ...await original<typeof import('./api')>(),
  get: vi.fn().mockResolvedValue([]), getWeather: vi.fn().mockRejectedValue(new Error('offline')), getNextSlide: vi.fn().mockResolvedValue(null),
}));

class FakeEventSource {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners: Array<(event: MessageEvent) => void> = [];
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: (event: MessageEvent) => void) { if (type === 'snapshot') this.listeners.push(listener); }
  close() { this.readyState = FakeEventSource.CLOSED; }
  open() { act(() => { this.readyState = FakeEventSource.OPEN; this.onopen?.(); }); }
  send(snapshot: unknown) { act(() => { for (const listener of this.listeners) listener(new MessageEvent('snapshot', { data: JSON.stringify(snapshot) })); }); }
  fail(closed = false) { act(() => { this.readyState = closed ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING; this.onerror?.(); }); }
}
const latest = () => FakeEventSource.instances.at(-1)!;

const light = (id: string, name: string, on: boolean, extra: Partial<HomeEntity> = {}): HomeEntity =>
  ({ id, domain: id.split('.')[0], name, state: on ? 'on' : 'off', available: true, on, toggleable: true, ...extra });
const home = (entities: HomeEntity[], status: HomeSnapshot['status'] = 'live'): HomeSnapshot => ({ status, message: null, entities });
const sample = () => home([
  light('light.kitchen', 'Kitchen', true, { brightness: 60 }),
  light('light.living_room', 'Living room', false),
  light('light.porch', 'Porch', false, { state: 'unavailable', available: false }),
  light('switch.fan', 'Ceiling fan', false),
  { id: 'climate.hallway', domain: 'climate', name: 'Hallway thermostat', state: 'heat', available: true, on: true, toggleable: false,
    currentTemperature: 68.5, targetTemperature: 70, hvacAction: 'heating', unit: '°F' },
]);

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Home automation screen', () => {
  it('shows lights, switches and read-only climate from the live feed', () => {
    render(<HomeAutomationScreen />);
    expect(latest().url).toBe('/api/home/events');
    expect(screen.getByText('Connecting to Home Assistant…').closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
    latest().open(); latest().send(sample());
    expect(screen.getByRole('status')).toHaveTextContent('Live from Home Assistant');
    const lights = screen.getByRole('region', { name: 'Lights' });
    expect(within(lights).getAllByRole('button').map(b => b.textContent)).toEqual(['KitchenOn · 60%', 'Living roomOff', 'PorchUnavailable']);
    expect(within(lights).getByRole('button', { name: /Kitchen/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(lights).getByRole('button', { name: /Kitchen/ })).toHaveAttribute('data-autofocus');
    expect(within(lights).getByRole('button', { name: /Porch/ })).toBeDisabled();
    expect(within(screen.getByRole('region', { name: 'Switches' })).getByRole('button', { name: /Ceiling fan/ })).toHaveAttribute('aria-pressed', 'false');
    const climate = screen.getByRole('region', { name: 'Climate' });
    expect(within(climate).queryByRole('button')).toBeNull();
    expect(within(climate).getByText('69°')).toBeInTheDocument();
    expect(within(climate).getByText('Heat · Heating')).toBeInTheDocument();
    expect(within(climate).getByText('Set to 70°')).toBeInTheDocument();
  });

  it('OK toggles through the API, shows progress, and settles on the state Home Assistant reports', async () => {
    render(<HomeAutomationScreen />);
    latest().open(); latest().send(sample());
    fireEvent.click(screen.getByRole('button', { name: /Living room/ }));
    expect(fetchMock).toHaveBeenCalledWith('/api/home/entities/light.living_room/toggle',
      expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' } }));
    expect(screen.getByRole('button', { name: /Living room/ })).toHaveTextContent('Turning on…');
    fireEvent.click(screen.getByRole('button', { name: /Living room/ })); // a second press while pending is ignored
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const updated = sample(); updated.entities[1] = light('light.living_room', 'Living room', true);
    latest().send(updated);
    expect(screen.getByRole('button', { name: /Living room/ })).toHaveTextContent('On');
    expect(screen.getByRole('button', { name: /Living room/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('updates live when a device changes elsewhere, without a reload', () => {
    render(<HomeAutomationScreen />);
    latest().open(); latest().send(sample());
    const changed = sample(); changed.entities[0] = light('light.kitchen', 'Kitchen', false);
    latest().send(changed);
    expect(screen.getByRole('button', { name: /Kitchen/ })).toHaveTextContent('Off');
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('shows why a toggle failed and frees the tile; a press with no answer times out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Home Assistant is not connected. Try again in a moment.' }), { status: 503 }));
    render(<HomeAutomationScreen />);
    latest().open(); latest().send(sample());
    fireEvent.click(screen.getByRole('button', { name: /Kitchen/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Home Assistant is not connected');
    expect(screen.getByRole('button', { name: /Kitchen/ })).toHaveTextContent('On · 60%');
    fireEvent.click(screen.getByRole('button', { name: /Ceiling fan/ }));
    expect(screen.getByRole('button', { name: /Ceiling fan/ })).toHaveTextContent('Turning on…');
    await act(async () => { await vi.advanceTimersByTimeAsync(PENDING_TIMEOUT + 100); });
    expect(screen.getByRole('button', { name: /Ceiling fan/ })).toHaveTextContent('Off');
  });

  it('keeps the last known state while reconnecting and reopens a stream the browser gave up on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<HomeAutomationScreen />);
    latest().open(); latest().send(sample());
    latest().fail();
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting… showing the last known state');
    expect(screen.getByRole('button', { name: /Kitchen/ })).toBeInTheDocument();
    expect(document.querySelector('.home-automation-screen')).toHaveClass('is-stale');
    latest().fail(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(HOME_RETRY_DELAYS[0] + 50); });
    expect(FakeEventSource.instances).toHaveLength(2);
    latest().open(); latest().send({ ...sample(), status: 'offline', message: 'Home Assistant is offline. Showing the last known state.' });
    expect(screen.getByRole('status')).toHaveTextContent('Home Assistant is offline. Showing the last known state.');
  });

  it('explains an unconfigured connection and an empty selection', () => {
    render(<HomeAutomationScreen />);
    latest().open(); latest().send({ status: 'not-configured', message: 'Connect Home Assistant in the administrator settings.', entities: [] });
    expect(screen.getByRole('heading', { name: 'Home Assistant isn’t connected yet' })).toBeInTheDocument();
    latest().send(home([]));
    expect(screen.getByRole('heading', { name: 'No devices selected' })).toBeInTheDocument();
  });

  it('rejects malformed snapshots', () => {
    expect(parseHomeSnapshot(sample())).not.toBeNull();
    expect(parseHomeSnapshot({ status: 'live', message: null, entities: [{ id: 'light.x' }] })).toBeNull();
    expect(parseHomeSnapshot({ status: 'hacked', message: null, entities: [] })).toBeNull();
    expect(parseHomeSnapshot({ ...sample(), entities: [{ ...sample().entities[0], brightness: 'lots' }] })).toBeNull();
  });
});

it('inside the TV shell, focus lands on the first light and Enter toggles it', async () => {
  window.history.replaceState(null, '', '/home-automation');
  render(<BrowserRouter unstable_useTransitions={false}><App /></BrowserRouter>);
  latest().open(); latest().send(sample());
  await waitFor(() => expect(screen.getByRole('button', { name: /Kitchen/ })).toHaveFocus());
  fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
  expect(fetchMock).toHaveBeenCalledWith('/api/home/entities/light.kitchen/toggle', expect.objectContaining({ method: 'POST' }));
  expect(screen.getByRole('button', { name: /Kitchen/ })).toHaveTextContent('Turning off…');
});
