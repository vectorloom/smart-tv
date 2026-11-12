import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PhotoStage, SLIDE_INTERVAL, slideMeta } from './PhotoStage';
vi.mock('./preload', () => ({ preloadImage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./api', () => ({
  imageUrl: (album: string, photo: string, size = 'thumbnail') => `/api/albums/${album}/photos/${photo}/image?size=${size}`,
  getNextSlide: vi.fn(),
}));
import { getNextSlide } from './api';
import { preloadImage } from './preload';

const slide = (n: number) => ({ albumId: 'lake', albumName: `Album ${n}`, photoId: `p${n}`, takenAt: '2024-11-30T23:30:00.000Z', index: n, total: 1340 });

describe('home photo slideshow', () => {
  it('formats the caption meta without shifting the month across timezones', () => {
    expect(slideMeta(slide(12))).toBe('November 2024 · 12 of 1,340');
    expect(slideMeta({ takenAt: null, index: 3, total: 9 })).toBe('3 of 9');
  });

  it('shows a preloaded photo, preloads the next, and crossfades every 30 seconds', async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.mocked(getNextSlide).mockImplementation(async () => slide(++n));
    render(<PhotoStage albums={[]} onOpenAlbum={() => {}} onAllAlbums={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole('heading', { name: 'Album 1' })).toBeInTheDocument();
    // The second photo is already requested and decoded while the first is showing.
    expect(vi.mocked(preloadImage)).toHaveBeenLastCalledWith('/api/albums/lake/photos/p2/image?size=preview');
    await act(async () => { await vi.advanceTimersByTimeAsync(SLIDE_INTERVAL - 1); });
    expect(screen.getByRole('heading', { name: 'Album 1' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole('heading', { name: 'Album 2' })).toBeInTheDocument();
    // Outgoing photo stays underneath while the new one fades in.
    expect([...document.querySelectorAll('.photo-slide')].map(img => img.getAttribute('src'))).toEqual([
      '/api/albums/lake/photos/p1/image?size=preview', '/api/albums/lake/photos/p2/image?size=preview']);
  });

  it('keeps the current photo when the next one fails', async () => {
    vi.useFakeTimers();
    vi.mocked(getNextSlide).mockResolvedValueOnce(slide(1)).mockRejectedValueOnce(new Error('down')).mockResolvedValue(slide(3));
    render(<PhotoStage albums={[]} onOpenAlbum={() => {}} onAllAlbums={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(SLIDE_INTERVAL); });
    expect(screen.getByRole('heading', { name: 'Album 1' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows only All albums when idle; once active, a single row of up to eight albums', () => {
    vi.mocked(getNextSlide).mockReturnValue(new Promise(() => {}));
    const albums = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, name: `Album ${i}`, assetCount: 1 }));
    const props = { onOpenAlbum: () => {}, onAllAlbums: () => {} };
    const { rerender } = render(<PhotoStage albums={albums} {...props} />);
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['All albums (8)']);
    rerender(<PhotoStage albums={albums} expanded {...props} />);
    expect(screen.getByRole('group', { name: 'Albums' }).querySelectorAll('button')).toHaveLength(8);
    expect(screen.getAllByRole('button')).toHaveLength(9);
    rerender(<PhotoStage albums={[...albums, { id: 'a8', name: 'Album 8', assetCount: 1 }]} expanded {...props} />);
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['All albums (9)']);
  });
});
