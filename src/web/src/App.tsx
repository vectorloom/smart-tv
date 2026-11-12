import { useCallback, useEffect, useRef, useState } from 'react';
import { useActivity } from './activity';
import { get, imageUrl, type Album, type Photo, type PhotoPage } from './api';
import { Home } from './Home';
import { isEditing, moveFocus } from './navigation';
import { Slideshow } from './Slideshow';
import { Stage } from './Stage';
import { type Command, useRemote } from './remote';
import { WeatherProvider } from './Weather';

/** Keyboard keys that act like remote buttons. Arrows/Enter/Escape on a PC behave exactly like the D-pad. */
export const KEY_COMMANDS: Record<string, Command> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Select', ' ': 'Select',
  Escape: 'Back', Backspace: 'Back', BrowserBack: 'Back', GoBack: 'Back', Home: 'Home', MediaPlayPause: 'PlayPause',
};

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

type View = 'home' | 'albums';

export function App() {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [view, setView] = useState<View>('home');
  const [album, setAlbum] = useState<Album | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [slide, setSlide] = useState<string | null>(null);
  const [visible, setVisible] = useState(60);
  const main = useRef<HTMLDivElement>(null);
  const onHome = view === 'home' && !album;
  const returnFocus = useRef<HTMLElement | null>(null);
  // The home button or album card that led to the current screen, restored on Back.
  const albumFocus = useRef<string | null>(null);
  // Set only by Back/Home navigation, so an unrelated home render cannot consume the target.
  const restoreOnHome = useRef(false);
  // Bumped when the first key on an idle home reveals the album row; focus moves onto it after render.
  const [rowRequest, setRowRequest] = useState(0);
  const handledRow = useRef(0);
  const activity = useActivity();

  function home() {
    exit();
    if (album || view !== 'home') { restoreOnHome.current = true; activity.wake(); }
    setAlbum(null); setView('home');
  }
  function back() {
    if (album) { if (view === 'home') { restoreOnHome.current = true; activity.wake(); } setAlbum(null); }
    else if (view === 'albums') { albumFocus.current = '__all'; restoreOnHome.current = true; activity.wake(); setView('home'); }
    else if (activity.active) { activity.sleep(); main.current?.focus(); }
  }
  function openAlbum(item: Album) { albumFocus.current = item.id; setAlbum(item); }
  function command(value: Command) {
    if (isEditing(document.activeElement) && !(document.activeElement instanceof HTMLSelectElement)) return;
    const wasIdle = activity.wake();
    if (value === 'Home') { home(); return; }
    if (slide) { window.dispatchEvent(new CustomEvent('tv-command', { detail: value })); return; }
    if (value === 'Back') { back(); return; }
    // On the idle home screen the first press only reveals the album row and focuses its first button.
    if (onHome && (wasIdle || !main.current?.contains(document.activeElement) || document.activeElement === main.current)) {
      setRowRequest(n => n + 1); return;
    }
    if (['Up', 'Down', 'Left', 'Right'].includes(value)) moveFocus(main.current!, `Arrow${value}`);
    if (value === 'Select') (document.activeElement as HTMLElement)?.click();
    if (value === 'PlayPause' && album && photos.length && !loading && !error) open(photos[0]);
  }
  const remote = useRemote('tv', command);
  const latestCommand = useRef(command);
  latestCommand.current = command;

  // Keys are handled at the window so a mouse click on the letterbox or photo never strands the keyboard.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const value = KEY_COMMANDS[event.key];
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const slideshow = document.querySelector<HTMLElement>('.slideshow');
      if (slideshow) {
        // The slideshow handles its own keys; only rescue them when focus fell back to the page.
        if (value && (document.activeElement === document.body || !document.activeElement)) {
          event.preventDefault(); slideshow.focus(); latestCommand.current(value);
        }
        return;
      }
      if (isEditing(event.target)) return;
      if (!value) return;
      event.preventDefault();
      latestCommand.current(value);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    const root = main.current;
    if (!root) return;
    if (onHome) {
      // The home screen is ambient: no focus ring until the first key press, except when
      // returning from an album, where focus goes back to the button that opened it.
      if (!activity.active) { handledRow.current = rowRequest; if (document.activeElement !== root) root.focus(); return; }
      if (handledRow.current !== rowRequest) {
        handledRow.current = rowRequest;
        root.querySelector<HTMLButtonElement>('.album-row button, [data-album="__all"]')?.focus();
        return;
      }
      if (restoreOnHome.current) {
        const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-album]')];
        const target = buttons.find(button => button.dataset.album === albumFocus.current) ?? buttons.find(button => button.dataset.album === '__all');
        if (target) { target.focus(); restoreOnHome.current = false; return; }
        if (!loading) restoreOnHome.current = false;
      }
      if (!root.contains(document.activeElement)) root.focus();
      return;
    }
    if (loading) {
      if (!root.contains(document.activeElement))
        (root.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? root).focus();
      return;
    }
    if (returnFocus.current?.isConnected) { returnFocus.current.focus(); returnFocus.current = null; return; }
    const restored = !album && albumFocus.current
      ? [...root.querySelectorAll<HTMLButtonElement>('[data-album]')].find(button => button.dataset.album === albumFocus.current) : null;
    (restored ?? root.querySelector<HTMLButtonElement>('[role="alert"] button') ?? root.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? root).focus();
  }, [loading, slide, onHome, album, activity.active, rowRequest]);

  // The home screen has no error panel, so a failed album list retries on its own (like photos and weather).
  useEffect(() => {
    if (!onHome || !error) return;
    const timer = window.setTimeout(() => setReload(value => value + 1), 15_000);
    return () => window.clearTimeout(timer);
  }, [onHome, error]);

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

  const retry = <button onClick={() => setReload(value => value + 1)}>Try again</button>;
  return <WeatherProvider><Stage>
    <div className="dashboard" hidden={slide !== null} tabIndex={-1} ref={main} inert={slide !== null}>
      {onHome ? <Home albums={albums} remote={remote} expanded={activity.active} onOpenAlbum={openAlbum}
        onAllAlbums={() => { albumFocus.current = null; setView('albums'); }} />
        : <main className="legacy">
          <div className="heading-row"><div><h1>{album?.name ?? 'All albums'}</h1>
            <p className="subtitle">{album ? `${photos.length} photos${loading ? ' · still loading' : ''}` : `${albums.length} albums`}</p></div>
            <div className="actions"><button onClick={back}>← Back</button>
              {album && <button className="primary" disabled={!photos.length || loading || !!error} onClick={() => open(photos[0])}>▶ Play album</button>}</div>
          </div>
          {error && <div className="notice" role="alert"><h3>We couldn’t load this collection</h3><p>{error}</p>{retry}</div>}
          {!album ? <>
            {loading && <p role="status" className="loading">Opening your collections…</p>}
            {!loading && !error && albums.length === 0 && <div className="notice"><h3>No accessible albums yet</h3><p>Albums owned by or shared with the configured Immich account will appear here.</p></div>}
            <div className="album-grid">{albums.map((item, index) => <AlbumCard key={item.id} item={item} index={index} onSelect={() => openAlbum(item)} />)}</div>
          </> : <>
            {loading && <p role="status" className="loading">Gathering your photos…</p>}
            {!loading && !error && photos.length === 0 && <div className="notice"><h3>No photos here yet</h3><p>This album has no available photos. Choose another album.</p></div>}
            <div className="photo-grid">{photos.slice(0, visible).map(photo => <button className="photo-card" key={photo.id} disabled={loading || !!error} onClick={() => open(photo)} aria-label={`Open ${photo.name}`}>
              <img src={imageUrl(album.id, photo.id)} alt="" loading="lazy" onError={event => { event.currentTarget.classList.add('image-failed'); }} />
              <span>{photo.name}</span>
            </button>)}</div>
            {visible < photos.length && <button className="load-more" onClick={() => setVisible(value => value + 60)}>Show more photos ({photos.length - visible} remaining)</button>}
          </>}
        </main>}
    </div>
    {slide && album && <Slideshow album={album.id} photos={photos} initialId={slide} onExit={exit} onHome={home} />}
  </Stage></WeatherProvider>;
}
