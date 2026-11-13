import { useEffect, useState, type ReactNode } from 'react';
import { getNextSlide, imageUrl, type Album, type SlideshowPhoto } from './api';
import { GridIcon } from './icons';
import { preloadImage } from './preload';

export const SLIDE_INTERVAL = 30_000;
const RETRY_INTERVAL = 15_000;
export const MAX_ALBUM_BUTTONS = 8;

type Slide = SlideshowPhoto & { url: string; key: number };
type Status = 'loading' | 'ready' | 'empty' | 'error';

const monthYear = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "November 2024 · 12 of 340". Immich's localDateTime is wall-clock time, so it is read as UTC to avoid shifting the month. */
export function slideMeta(slide: Pick<SlideshowPhoto, 'takenAt' | 'index' | 'total'>): string {
  const position = `${slide.index.toLocaleString('en-US')} of ${slide.total.toLocaleString('en-US')}`;
  const taken = slide.takenAt ? new Date(slide.takenAt) : null;
  return taken && !Number.isNaN(taken.getTime()) ? `${monthYear.format(taken)} · ${position}` : position;
}

/**
 * Random photos from the selected albums, crossfading every 30 seconds. The next photo is
 * requested and decoded while the current one is on screen (the server prefetches the one
 * after that), so each change is a pure fade.
 */
export function PhotoStage({ albums, expanded = false, onOpenAlbum, onAllAlbums, children }: {
  albums: Album[]; expanded?: boolean; onOpenAlbum: (album: Album) => void; onAllAlbums: () => void; children?: ReactNode;
}) {
  const [slides, setSlides] = useState<Slide[]>([]);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    let alive = true;
    let key = 0;
    let timer: number | undefined;
    const controller = new AbortController();
    const fetchNext = async (): Promise<Slide | 'empty' | 'error'> => {
      try {
        const next = await getNextSlide(controller.signal);
        if (!next) return 'empty';
        const url = imageUrl(next.albumId, next.photoId, 'preview');
        await preloadImage(url);
        return { ...next, url, key: ++key };
      } catch { return 'error'; }
    };
    let upcoming = fetchNext();
    const advance = async () => {
      const result = await upcoming;
      if (!alive) return;
      if (typeof result === 'object') {
        // Keep the outgoing photo underneath while the new one fades in on top.
        setSlides(previous => [...previous.slice(-1), result]);
        setStatus('ready');
      } else setStatus(previous => previous === 'ready' ? previous : result);
      upcoming = fetchNext();
      timer = window.setTimeout(() => { void advance(); }, typeof result === 'object' ? SLIDE_INTERVAL : RETRY_INTERVAL);
    };
    void advance();
    return () => { alive = false; window.clearTimeout(timer); controller.abort(); };
  }, []);

  const current = slides[slides.length - 1];
  return <section className="photo-stage" aria-label="Photo slideshow">
    {slides.map(slide => <img key={slide.key} className="photo-slide" src={slide.url} alt="" />)}
    {status !== 'ready' && <p className="photo-status" role="status">{{
      loading: 'Loading photos…',
      empty: 'No photos to show yet. Select albums in the administrator settings.',
      error: 'Photos are unavailable right now. Retrying automatically.',
      ready: '',
    }[status]}</p>}
    {children}
    <div className={`photo-scrim${expanded ? ' is-expanded' : ''}`}>
      {/* Idle: one quiet button. After a key press (until 30 s idle): one row of albums above the caption. */}
      {expanded && albums.length > 0 && albums.length <= MAX_ALBUM_BUTTONS && <div className="album-row" role="group" aria-label="Albums">
        {albums.map(album => <button className="pill" key={album.id} data-album={album.id} data-focus-key={`album:${album.id}`} onClick={() => onOpenAlbum(album)}>
          <span>{album.name}</span>
        </button>)}
      </div>}
      <div className="photo-bottom">
        {current ? <div className="photo-caption" aria-live="polite">
          <p className="label photo-kicker">Now showing</p>
          <h1 className="photo-album">{current.albumName}</h1>
          <p className="photo-meta">{slideMeta(current)}</p>
        </div> : <div className="photo-caption" />}
        {albums.length > 0 && <button className="pill pill-quiet" data-album="__all" data-focus-key="albums:all" onClick={onAllAlbums}>
          <GridIcon />All albums ({albums.length})
        </button>}
      </div>
    </div>
  </section>;
}
