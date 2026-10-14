import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
vi.mock('./remote', () => ({ useRemote: () => ({ ready: true, status: 'No phone connected', connected: false, paired: false, code: '', send: vi.fn() }) }));
vi.mock('./api', () => ({
  imageUrl: (album: string, photo: string, size = 'thumbnail') => `/api/albums/${album}/photos/${photo}/image?size=${size}`,
  get: vi.fn(), getWeather: vi.fn().mockRejectedValue(new Error('offline')),
}));
import { get } from './api';
const albums = [
  { id: 'a', name: 'First', assetCount: 1, thumbnailId: 'cover-a' },
  { id: 'b', name: 'Second', assetCount: 0 },
];

describe('TV gallery navigation', () => {
  it('renders album covers through the dashboard image endpoint and falls back after an image error', async () => {
    vi.mocked(get).mockImplementation(async url => url === '/api/albums' ? albums : { items: [], nextPage: null });
    render(<App />);
    expect(screen.getByText('YOUR HOME, ON THE BIG SCREEN')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('A little of everything. All in one place.');
    expect(screen.getByText('Photos, local weather, and the things that make your home yours.')).toBeInTheDocument();
    const first = await screen.findByRole('button', { name: /First/ });
    const cover = first.querySelector<HTMLImageElement>('.album-cover');
    expect(cover).toHaveAttribute('src', '/api/albums/a/photos/cover-a/image?size=thumbnail');
    expect(first.querySelector('.album-symbol')).toBeNull();

    const second = screen.getByRole('button', { name: /Second/ });
    expect(second.querySelector('.album-cover')).toBeNull();
    expect(second.querySelector('.album-symbol')).toHaveTextContent('▧');

    fireEvent.error(cover!);
    await waitFor(() => expect(first.querySelector('.album-cover')).toBeNull());
    expect(first.querySelector('.album-symbol')).toHaveTextContent('▧');
  });

  it('restores the selected album after Backspace and Home, including an empty album', async () => {
    vi.mocked(get).mockImplementation(async url => url === '/api/albums' ? albums : { items: [], nextPage: null });
    render(<App />);
    const second = await screen.findByRole('button', { name: /Second/ });
    second.focus(); fireEvent.keyDown(second, { key: 'Enter' });
    await screen.findByText('No photos here yet');
    expect(screen.getByRole('button', { name: /Play album/ })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('button', { name: /Albums/ }), { key: 'Backspace' });
    await waitFor(() => expect(screen.getByRole('button', { name: /Second/ })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole('button', { name: /Second/ }), { key: ' ' });
    await screen.findByText('No photos here yet');
    fireEvent.keyDown(screen.getByRole('button', { name: /Albums/ }), { key: 'Home' });
    await waitFor(() => expect(screen.getByRole('button', { name: /Second/ })).toHaveFocus());
  });
  it('focuses retry after an error and restores a usable control after retry', async () => {
    vi.mocked(get).mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce([]);
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole('button', { name: 'Try again' }), { key: 'Enter' });
    await screen.findByText('Your collection starts here');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pair phone' })).toHaveFocus());
  });
});
