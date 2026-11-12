import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { clearPhotoCache } from './albums';
vi.mock('./remote', () => ({ useRemote: () => ({ ready: true, status: 'No phone connected', connected: false, paired: false, code: '', send: vi.fn() }) }));
vi.mock('./preload', () => ({ preloadImage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./api', async original => ({
  ...await original<typeof import('./api')>(),
  get: vi.fn(), getWeather: vi.fn().mockRejectedValue(new Error('offline')),
  getNextSlide: vi.fn().mockResolvedValue(null),
}));
import { get } from './api';

const albums = [
  { id: 'a', name: 'First', assetCount: 2, thumbnailId: 'cover-a' },
  { id: 'b', name: 'Second', assetCount: 0 },
];
const photos = { items: [{ id: 'p1', name: 'Mountain morning' }, { id: 'p2', name: 'Quiet afternoon' }], nextPage: null };
const key = (k: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key: k });
const renderApp = (path = '/') => { window.history.replaceState(null, '', path); return render(<BrowserRouter unstable_useTransitions={false}><App /></BrowserRouter>); };
const mockApi = (list = albums) => vi.mocked(get).mockImplementation(async url =>
  url === '/api/albums' ? list : url.startsWith('/api/albums/b/') ? { items: [], nextPage: null } : photos);

describe('TV shell: home, rail and album navigation', () => {
  beforeEach(() => { vi.mocked(get).mockReset(); clearPhotoCache(); });
  afterEach(() => { vi.useRealTimers(); });

  it('idles with only an All albums button, a hidden rail, no hero and nothing focused', async () => {
    mockApi();
    renderApp();
    await screen.findByRole('button', { name: 'All albums (2)' });
    expect(screen.queryByRole('button', { name: 'First' })).toBeNull();
    expect(screen.queryByText('A little of everything. All in one place.')).toBeNull();
    expect(screen.getByText('No photos to show yet. Select albums in the administrator settings.')).toBeInTheDocument();
    expect(document.querySelector('.nav-rail')).toHaveClass('is-hidden');
    expect(document.querySelector('.nav-rail')).toHaveAttribute('inert');
    // Pairing moved to Settings.
    expect(screen.queryByRole('button', { name: /Pair phone/ })).toBeNull();
    expect(document.activeElement).toHaveClass('screen');
  });

  it('the first key reveals the rail and album row; an album opens on its route and Back restores focus', async () => {
    mockApi();
    renderApp();
    await screen.findByRole('button', { name: 'All albums (2)' });
    key('ArrowDown');
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    expect(document.querySelector('.nav-rail')).toHaveClass('is-overlay');
    screen.getByRole('button', { name: 'Second' }).focus(); // arrow geometry is covered by the browser tests
    key('Enter');
    await screen.findByText('No photos here yet');
    expect(window.location.pathname).toBe('/photos/b');
    expect(screen.getByRole('button', { name: /Play album/ })).toBeDisabled();
    key('Backspace');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus());
    expect(window.location.pathname).toBe('/');
    key(' ');
    await screen.findByText('No photos here yet');
    key('Home');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus());
    // Back on the home screen walks history first; on the first entry it hides the rail and row.
    key('Escape');
    await waitFor(() => expect(window.location.pathname).toBe('/photos/b'));
    key('Escape');
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus());
  });

  it('Back on the first home entry hides the rail and album row', async () => {
    mockApi();
    renderApp();
    await screen.findByRole('button', { name: 'All albums (2)' });
    key('ArrowDown');
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    key('Escape');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'First' })).toBeNull());
    expect(document.querySelector('.nav-rail')).toHaveClass('is-hidden');
    expect(document.activeElement).toHaveClass('screen');
  });

  it('hides the rail and album row after 30 seconds without input', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApi();
    renderApp();
    await screen.findByRole('button', { name: 'All albums (2)' });
    key('ArrowDown');
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
    screen.getByRole('button', { name: 'Second' }).focus();
    key('ArrowRight'); // any key keeps them open
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
    expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.queryByRole('button', { name: 'Second' })).toBeNull();
    expect(document.querySelector('.nav-rail')).toHaveClass('is-hidden');
    expect(document.activeElement).toHaveClass('screen');
  });

  it('keeps keys working after a mouse click moves focus off the screen', async () => {
    mockApi();
    renderApp();
    await screen.findByRole('button', { name: 'All albums (2)' });
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Second' }));
    await screen.findByText('No photos here yet');
  });

  it('rail buttons navigate to every screen; unknown paths go home', async () => {
    mockApi();
    renderApp('/weather');
    expect(screen.getByRole('heading', { level: 1, name: 'Weather' })).toBeInTheDocument();
    const rail = screen.getByRole('navigation', { name: 'Main' });
    expect(rail).toHaveClass('is-collapsed');
    for (const [label, path, heading] of [['Settings', '/preferences', 'Settings'], ['Calendar', '/calendar', 'Calendar'],
      ['Home automation', '/home-automation', 'Home automation'], ['Photos', '/photos', 'Photos']] as const) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() => expect(window.location.pathname).toBe(path));
      expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-current', 'page');
    }
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    act(() => {
      window.history.pushState(null, '', '/nowhere');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(window.location.pathname).toBe('/'));
  });

  it('opens the viewer from an album and returns focus to the photo when it closes', async () => {
    mockApi();
    renderApp('/photos/a');
    const photo = await screen.findByRole('button', { name: 'Open Quiet afternoon' });
    photo.focus(); key('Enter');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(window.location.search).toBe('?photo=p2');
    expect(document.querySelector('.dashboard')).not.toBeVisible();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Quiet afternoon' })).toHaveFocus());
  });

  it('shows albums as rows on Photos and retries a failed list on its own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(get).mockRejectedValueOnce(new Error('API starting.')).mockImplementation(async url => url === '/api/albums' ? albums : photos);
    renderApp('/photos');
    expect(await screen.findByRole('alert')).toHaveTextContent('API starting.');
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(await screen.findByRole('region', { name: 'First' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Open / })).toHaveLength(4));
    expect(screen.getAllByRole('button', { name: /See all/ })).toHaveLength(2);
  });
});
