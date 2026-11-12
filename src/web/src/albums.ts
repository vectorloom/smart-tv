import { useEffect, useState } from 'react';
import { get, type Album, type Photo, type PhotoPage } from './api';

const RETRY_AFTER = 15_000;

export type AlbumsState = { albums: Album[]; loading: boolean; error: string; retry: () => void };

/** Albums selected in the administrator settings. Failures retry on their own every 15 s. */
export function useAlbums(): AlbumsState {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    setLoading(true);
    get<Album[]>('/api/albums', controller.signal)
      .then(result => { setAlbums(result); setError(''); setLoading(false); })
      .catch(reason => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : 'Could not load albums.');
        setLoading(false);
        timer = window.setTimeout(() => setAttempt(n => n + 1), RETRY_AFTER);
      });
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [attempt]);
  return { albums, loading, error, retry: () => setAttempt(n => n + 1) };
}

// First pages are shared by the Photos rows and the album screen, so going back and forth is instant.
const firstPages = new Map<string, Promise<PhotoPage>>();
export function firstPage(albumId: string, signal?: AbortSignal): Promise<PhotoPage> {
  let page = firstPages.get(albumId);
  if (!page) {
    page = get<PhotoPage>(`/api/albums/${encodeURIComponent(albumId)}/photos?page=1`);
    firstPages.set(albumId, page);
    // A failed load is not cached; the next visit tries again.
    page.catch(() => firstPages.delete(albumId));
    // Drop cached pages after ten minutes so new photos show up.
    window.setTimeout(() => { if (firstPages.get(albumId) === page) firstPages.delete(albumId); }, 10 * 60_000);
  }
  if (!signal) return page;
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    page.then(resolve, reject);
  });
}
/** Whether an album's first page is already cached (loading it again costs nothing). */
export function hasFirstPage(albumId: string): boolean { return firstPages.has(albumId); }
/** Test hook: forget cached first pages. */
export function clearPhotoCache() { firstPages.clear(); }

export type PhotosState = { photos: Photo[]; loading: boolean; error: string; retry: () => void };

/** Every photo in an album, page by page; the list grows as pages arrive. */
export function useAlbumPhotos(albumId: string): PhotosState {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setPhotos([]);
    (async () => {
      try {
        const items: Photo[] = [];
        const seen = new Set<string>();
        let page: number | null = 1;
        while (page !== null) {
          const result: PhotoPage = page === 1 ? await firstPage(albumId, controller.signal)
            : await get(`/api/albums/${encodeURIComponent(albumId)}/photos?page=${page}`, controller.signal);
          for (const photo of result.items) if (!seen.has(photo.id)) { items.push(photo); seen.add(photo.id); }
          if (result.nextPage !== null && result.nextPage <= page) throw new Error('Photo pagination could not continue. Please retry.');
          page = result.nextPage;
          if (!controller.signal.aborted) setPhotos([...items]);
        }
        if (!controller.signal.aborted) setLoading(false);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : 'Could not load photos.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [albumId, attempt]);
  return { photos, loading, error, retry: () => setAttempt(n => n + 1) };
}
