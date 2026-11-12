import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
vi.mock('./remote', () => ({ useRemote: () => ({ ready: true, status: 'No phone connected', connected: false, paired: false, code: '', send: vi.fn() }) }));
vi.mock('./preload', () => ({ preloadImage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./api', async original => ({
  ...await original<typeof import('./api')>(),
  get: vi.fn(), getWeather: vi.fn().mockRejectedValue(new Error('offline')),
  getNextSlide: vi.fn().mockResolvedValue(null),
}));
import { get } from './api';
const albums = [
  { id: 'a', name: 'First', assetCount: 1, thumbnailId: 'cover-a' },
  { id: 'b', name: 'Second', assetCount: 0 },
];
const many = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, name: `Album ${i}`, assetCount: 3, thumbnailId: null }));
const key = (k: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key: k });

describe('TV home and album navigation', () => {
  beforeEach(() => { vi.mocked(get).mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('idles with only an All albums button, no hero and nothing focused', async () => {
    vi.mocked(get).mockImplementation(async url => url === '/api/albums' ? albums : { items: [], nextPage: null });
    render(<App />);
    await screen.findByRole('button', { name: 'All albums (2)' });
    expect(screen.queryByRole('button', { name: 'First' })).toBeNull();
    expect(screen.queryByText('A little of everything. All in one place.')).toBeNull();
    expect(screen.getByText('No photos to show yet. Select albums in the administrator settings.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pair phone/ })).toBeInTheDocument();
    expect(document.activeElement).toHaveClass('dashboard');
  });

  it('reveals the album row on the first key, and Back/Home restore focus to the album button', async () => {
    vi.mocked(get).mockImplementation(async url => url === '/api/albums' ? albums : { items: [], nextPage: null });
    render(<App />);
    await screen.findByRole('button', { name: 'All albums (2)' });
    key('ArrowDown');
    // The first press only reveals the row; it does not also move.
    await waitFor(() => expect(screen.getByRole('button', { name: 'First' })).toHaveFocus());
    screen.getByRole('button', { name: 'Second' }).focus(); // arrow geometry is covered by the browser tests
    key('Enter');
    await screen.findByText('No photos here yet');
    expect(screen.getByRole('button', { name: /Play album/ })).toBeDisabled();
    key('Backspace');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus());
    key(' ');
    await screen.findByText('No photos here yet');
    key('Home');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus());
    // Back on the home screen hides the row again.
    key('Escape');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Second' })).toBeNull());
    expect(document.activeElement).toHaveClass('dashboard');
  });

  it('hides the album row after 30 seconds without input', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(get).mockImplementation(async url => url === '/api/albums' ? albums : { items: [], nextPage: null });
    render(<App />);
    await screen.findByRole('button', { name: 'All albums (2)' });
    key('ArrowDown');
    await waitFor(() => expect(screen.getByRole('button', { name: 'First' })).toHaveFocus());
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
    expect(screen.getByRole('button', { name: 'First' })).toBeInTheDocument();
    screen.getByRole('button', { name: 'Second' }).focus();
    key('ArrowRight'); // any key keeps the row open
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
    expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.queryByRole('button', { name: 'Second' })).toBeNull();
    expect(document.activeElement).toHaveClass('dashboard');
  });

  it('keeps keys working after a mouse click moves focus off the dashboard', async () => {
    vi.mocked(get).mockImplementation(async url => url === '/api/albums' ? albums : { items: [], nextPage: null });
    render(<App />);
    await screen.findByRole('button', { name: 'All albums (2)' });
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'First' })).toHaveFocus());
    // A click opens an album exactly like Enter.
    fireEvent.click(screen.getByRole('button', { name: 'Second' }));
    await screen.findByText('No photos here yet');
  });

  it('collapses more than eight albums into All albums, whose list returns focus to it', async () => {
    vi.mocked(get).mockImplementation(async url => url === '/api/albums' ? many : { items: [], nextPage: null });
    render(<App />);
    const all = await screen.findByRole('button', { name: 'All albums (9)' });
    key('ArrowDown');
    await waitFor(() => expect(all).toHaveFocus());
    expect(screen.queryByRole('button', { name: 'Album 0' })).toBeNull();
    key('Enter');
    await screen.findByRole('heading', { name: 'All albums' });
    const card = screen.getByRole('button', { name: /Album 8/ });
    card.focus(); key('Enter');
    await screen.findByRole('heading', { name: 'Album 8' });
    key('Escape');
    await waitFor(() => expect(screen.getByRole('button', { name: /Album 8/ })).toHaveFocus());
    key('Escape');
    await waitFor(() => expect(screen.getByRole('button', { name: 'All albums (9)' })).toHaveFocus());
  });

  it('renders album covers in the album list and falls back after an image error', async () => {
    vi.mocked(get).mockImplementation(async url => url === '/api/albums' ? many.map((a, i) => i === 0 ? { ...a, thumbnailId: 'cover' } : a) : { items: [], nextPage: null });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'All albums (9)' }));
    const first = await screen.findByRole('button', { name: /Album 0/ });
    const cover = first.querySelector<HTMLImageElement>('.album-cover');
    expect(cover).toHaveAttribute('src', '/api/albums/m0/photos/cover/image?size=thumbnail');
    fireEvent.error(cover!);
    await waitFor(() => expect(first.querySelector('.album-cover')).toBeNull());
    expect(first.querySelector('.album-symbol')).toHaveTextContent('▧');
  });

  it('focuses retry after an album list error', async () => {
    vi.mocked(get).mockImplementation(async url => url === '/api/albums' ? many : { items: [], nextPage: null });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'All albums (9)' }));
    await screen.findByRole('heading', { name: 'All albums' });
    const card = screen.getByRole('button', { name: /Album 1/ });
    vi.mocked(get).mockRejectedValueOnce(new Error('Unavailable'));
    fireEvent.click(card);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toHaveFocus());
  });

  it('retries the album list on the home screen after a failure', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(get).mockRejectedValueOnce(new Error('API starting')).mockImplementation(async () => albums);
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.queryByRole('button', { name: /All albums/ })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByRole('button', { name: 'All albums (2)' })).toBeInTheDocument();
  });
});
