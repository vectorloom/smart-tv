import { useCallback, useEffect, useRef, useState } from 'react';
import { get, imageUrl, type Album, type Photo, type PhotoPage } from './api';
import { isEditing, moveFocus } from './navigation';
import { Slideshow } from './Slideshow';
import { WeatherPanel } from './WeatherPanel';
import { type Command, useRemote } from './remote';

function AlbumCard({ item, index, onSelect }: { item: Album; index: number; onSelect: () => void }) {
  const [imageFailed, setImageFailed] = useState(false);
  const thumbnail = item.thumbnailId && !imageFailed ? imageUrl(item.id, item.thumbnailId) : null;
  return <button className={`album-card tone-${index % 4}`} data-album={item.id} onClick={onSelect}>
    <div className="album-art" aria-hidden="true">
      <span className="album-number">{String(index + 1).padStart(2, '0')}</span>
      {thumbnail
        ? <img className="album-cover" src={thumbnail} alt="" loading="lazy" onError={() => setImageFailed(true)} />
        : <span className="album-symbol">▧</span>}
    </div>
    <div className="album-info"><div><h3>{item.name}</h3><p>{item.assetCount} items</p></div><span aria-hidden="true">↗</span></div>
  </button>;
}

export function App() {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [album, setAlbum] = useState<Album | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [slide, setSlide] = useState<string | null>(null);
  const [visible, setVisible] = useState(60);
  const main = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const albumFocus = useRef<string | null>(null);
  function home() { exit(); setAlbum(null); }
  function command(value: Command) {
    if (isEditing(document.activeElement) && !(document.activeElement instanceof HTMLSelectElement)) return;
    if (value === 'Home') { home(); return; }
    if (slide) { window.dispatchEvent(new CustomEvent('tv-command', { detail: value })); return; }
    if (value === 'Back') { setAlbum(null); return; }
    if (['Up', 'Down', 'Left', 'Right'].includes(value)) moveFocus(main.current!, `Arrow${value}`);
    if (value === 'Select') (document.activeElement as HTMLElement)?.click();
    if (value === 'PlayPause' && album && photos.length && !loading && !error) open(photos[0]);
  }
  const remote = useRemote('tv', command);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setPhotos([]); setVisible(60);
    async function load() {
      try {
        if (!album) setAlbums(await get<Album[]>('/api/albums', controller.signal));
        else {
          let page: number | null = 1;
          const items: Photo[] = [];
          const seen = new Set<string>();
          while (page !== null) {
            const result: PhotoPage = await get(`/api/albums/${album.id}/photos?page=${page}`, controller.signal);
            for (const photo of result.items) if (!seen.has(photo.id)) { items.push(photo); seen.add(photo.id); }
            if (result.nextPage !== null && result.nextPage <= page) throw new Error('Photo pagination could not continue. Please retry.');
            page = result.nextPage;
            setPhotos([...items]);
          }
        }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load photos.');
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [album, reload]);

  useEffect(() => {
    if (slide) return;
    if (loading) {
      if (!main.current?.contains(document.activeElement))
        (main.current?.querySelector<HTMLButtonElement>('main button:not(:disabled)') ?? main.current)?.focus();
      return;
    }
    {
      if (returnFocus.current?.isConnected) { returnFocus.current.focus(); returnFocus.current = null; return; }
      const restored = !album && albumFocus.current
        ? [...main.current!.querySelectorAll<HTMLButtonElement>('[data-album]')].find(button => button.dataset.album === albumFocus.current) : null;
      (restored ?? main.current?.querySelector<HTMLButtonElement>('main button:not(:disabled), .pairing button:not(:disabled)') ?? main.current)?.focus();
    }
  }, [loading, slide]);

  const exit = useCallback(() => {
    setSlide(null);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, []);

  function open(photo: Photo) {
    returnFocus.current = document.activeElement as HTMLElement;
    setSlide(photo.id);
    // Call in the user gesture. The fixed overlay still works if TV browsers deny fullscreen.
    if (!document.fullscreenElement && document.documentElement.requestFullscreen)
      void document.documentElement.requestFullscreen().catch(() => {});
  }

  return <>
    <div className="dashboard" hidden={slide !== null} tabIndex={-1} ref={main} inert={slide !== null} onKeyDown={event => {
      if (isEditing(event.target)) return;
      const keys: Record<string, Command> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Select', ' ': 'Select', Escape: 'Back', Backspace: 'Back', Home: 'Home' };
      if (keys[event.key]) { event.preventDefault(); command(keys[event.key]); }
    }}>
      <header><a className="wordmark" href="/" tabIndex={-1}>still<span> / </span>home</a></header>
      <main>
        <div className="eyebrow">{album ? 'THE COLLECTION' : 'YOUR HOME, ON THE BIG SCREEN'}</div>
        <div className="heading-row"><div><h1>{album?.name ?? 'A little of everything. All in one place.'}</h1><p className="subtitle">{album ? `${photos.length} photos${loading ? ' · still loading' : ''} · Find a favorite, or let them play.` : 'Photos, local weather, and the things that make your home yours.'}</p></div>
          {album && <div className="actions"><button onClick={() => setAlbum(null)}>← Albums</button><button className="primary" disabled={!photos.length || loading || !!error} onClick={() => open(photos[0])}>▶ Play album</button></div>}
        </div>
        {!album ? <div className="dashboard-layout">
          <section className="collection-panel" aria-labelledby="collection-title">
            <div className="section-label"><h2 id="collection-title">Albums</h2><span>{albums.length} COLLECTIONS</span></div>
            {error && <div className="notice" role="alert"><h3>We couldn’t load this collection</h3><p>{error}</p><button onClick={() => setReload(value => value + 1)}>Try again</button></div>}
            {loading && <p role="status" className="loading">Opening your collections…</p>}
            {!loading && !error && albums.length === 0 && <div className="notice"><h3>No accessible albums yet</h3><p>Albums owned by or shared with the configured Immich account will appear here.</p></div>}
            <div className="album-grid">{albums.map((item, index) => <AlbumCard key={item.id} item={item} index={index} onSelect={() => { albumFocus.current = item.id; setAlbum(item); }} />)}</div>
          </section>
          <WeatherPanel />
        </div> : <>
          <div className="section-label"><h2>All photos</h2><span>CHOOSE A PHOTO TO BEGIN</span></div>
          {error && <div className="notice" role="alert"><h3>We couldn’t load this collection</h3><p>{error}</p><button onClick={() => setReload(value => value + 1)}>Try again</button></div>}
          {loading && <p role="status" className="loading">Gathering your photos…</p>}
          {!loading && !error && photos.length === 0 && <div className="notice"><h3>No photos here yet</h3><p>This album has no available photos. Choose another album.</p></div>}
          <div className="photo-grid">{photos.slice(0, visible).map(photo => <button className="photo-card" key={photo.id} disabled={loading || !!error} onClick={() => open(photo)} aria-label={`Open ${photo.name}`}>
            <img src={imageUrl(album.id, photo.id)} alt="" loading="lazy" onError={event => { event.currentTarget.classList.add('image-failed'); }} />
            <span>{photo.name}</span>
          </button>)}</div>
          {visible < photos.length && <button className="load-more" onClick={() => setVisible(value => value + 60)}>Show more photos ({photos.length - visible} remaining)</button>}
        </>}
      </main>
      <section className="pairing" aria-label="Phone pairing">
        <div><span aria-live="polite">Phone remote: {remote.status}</span>
          {remote.code && <p>Open <strong>/remote</strong> on your phone and enter <strong className="pair-code">{remote.code}</strong><br />Code expires in two minutes.</p>}
        </div>
        <button disabled={!remote.ready} onClick={() => remote.send({ type: 'code' })}>{remote.code ? 'New pairing code' : 'Pair phone'}</button>
        {remote.paired && <button onClick={() => remote.send({ type: 'unpair' })}>Unpair phone</button>}
      </section>
      <footer><span><kbd>↑ ↓ ← →</kbd> Navigate <kbd>Enter</kbd> Select <kbd>Esc</kbd> Back</span><span>MAKE YOURSELF AT HOME</span></footer>
    </div>
    {slide && album && <Slideshow album={album.id} photos={photos} initialId={slide} onExit={exit} onHome={home} />}
  </>;
}
