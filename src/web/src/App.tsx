import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useActivity } from './activity';
import { AlbumScreen } from './AlbumScreen';
import { useAlbums } from './albums';
import type { Album, Photo } from './api';
import { SCREEN_COMMAND, defaultFocus, findFocusKey, parentPath, zoneOf } from './focus';
import { Home } from './Home';
import { HomeAutomationScreen } from './HomeAutomationScreen';
import { NavRail } from './NavRail';
import { isEditing, moveFocus } from './navigation';
import { PhotosScreen } from './PhotosScreen';
import { PlaceholderScreen, PreferencesScreen } from './PreferencesScreen';
import { type Command, useRemote } from './remote';
import { STAGE_WIDTH, Stage } from './Stage';
import { WeatherProvider } from './Weather';
import { WeatherScreen } from './WeatherScreen';

/** Keyboard keys that act like remote buttons. Arrows/Enter/Escape on a PC behave exactly like the D-pad. */
export const KEY_COMMANDS: Record<string, Command> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Select', ' ': 'Select',
  Escape: 'Back', Backspace: 'Back', BrowserBack: 'Back', GoBack: 'Back', Home: 'Home', MediaPlayPause: 'PlayPause',
};

/** Stage px: the left-edge strip that opens the home flyout, its open width, and the close delay. */
const RAIL_EDGE = 112;
const RAIL_EXPANDED = 340;
export const RAIL_POINTER_LEAVE = 1500;

export function App() {
  return <WeatherProvider><Stage><Shell /></Stage></WeatherProvider>;
}

type NavState = { focus?: string } | null;

function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const albums = useAlbums();
  const activity = useActivity();
  const rail = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const isHome = location.pathname === '/';
  const viewerOpen = new URLSearchParams(location.search).has('photo');
  // On home the rail is a flyout. Keys and remote buttons open it (closing after 30 s without input);
  // a mouse opens it only at the left edge and it closes shortly after the pointer leaves, so moving
  // the mouse over the photo never leaves it hanging open. Choosing an item closes it.
  const [railByKey, setRailByKey] = useState(false);
  const [railByPointer, setRailByPointer] = useState(false);
  const [railDismissed, setRailDismissed] = useState(false);
  const railOpen = activity.active && !railDismissed && (railByKey || railByPointer);
  const railMode = isHome ? (railOpen ? 'overlay' : 'hidden') : 'collapsed';

  // ---- Focus memory: the last focused content element per history entry, restored on Back/popstate.
  const memory = useRef(new Map<string, string>());
  const entry = useRef(location.key);
  entry.current = location.key;
  useEffect(() => {
    const record = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      const key = target.closest?.('[data-focus-key]')?.getAttribute('data-focus-key');
      if (key && content.current?.contains(target)) memory.current.set(entry.current, key);
    };
    document.addEventListener('focusin', record);
    return () => document.removeEventListener('focusin', record);
  }, []);

  const focusContent = useCallback(() => {
    const root = content.current;
    if (!root) return;
    (findFocusKey(root, memory.current.get(entry.current)) ?? defaultFocus(root))?.focus();
  }, []);
  const focusRail = useCallback(() => {
    flushSync(() => { setRailDismissed(false); setRailByKey(true); });
    const root = rail.current;
    (root?.querySelector<HTMLElement>('[aria-current="page"]') ?? root?.querySelector<HTMLElement>('button'))?.focus();
  }, []);

  // On every location change (links, rail, Back, popstate): restore the remembered element, or the
  // element the navigation asked for, or the screen's default. Content may still be loading, so keep
  // trying as it renders until something is focused, the user acts, or five seconds pass.
  const loadedEntry = useRef(location.key);
  const cancelRestore = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    // A navigation's focus hint is for that navigation only. History state survives a reload, and
    // re-applying an old hint then would reveal the album row on a freshly loaded, idle screen.
    const hint = location.key === loadedEntry.current ? undefined : (location.state as NavState)?.focus;
    if (viewerOpen) return;
    const root = content.current!;
    const target = memory.current.get(location.key) ?? hint;
    if (isHome && target) activity.wake(); // the album row must be showing for its button to take focus
    let finished = false;
    const attempt = () => {
      if (finished) return true;
      if (target) {
        const element = findFocusKey(root, target);
        if (element) { element.focus(); finished = true; }
        return finished;
      }
      if (isHome) { root.focus({ preventScroll: true }); return finished = true; } // ambient: no ring until a key
      const element = defaultFocus(root);
      if (element) { element.focus(); finished = true; }
      return finished;
    };
    if (attempt()) return;
    const observer = new MutationObserver(() => { if (attempt()) stop(); });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'aria-busy'] });
    const userActed = () => stop();
    window.addEventListener('keydown', userActed, true);
    window.addEventListener('pointerdown', userActed, true);
    const timer = window.setTimeout(() => {
      stop();
      if (!root.contains(document.activeElement) && !rail.current?.contains(document.activeElement)) (defaultFocus(root) ?? root).focus();
    }, 5000);
    cancelRestore.current = stop;
    function stop() {
      finished = true;
      observer.disconnect();
      window.clearTimeout(timer);
      window.removeEventListener('keydown', userActed, true);
      window.removeEventListener('pointerdown', userActed, true);
    }
    return stop;
    // Runs per history entry; `activity` and `isHome` are read for that entry only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, viewerOpen]);

  // Mouse on home: the left edge (the rail's width once open) opens the flyout; leaving closes it.
  const railShown = useRef(false);
  railShown.current = railMode === 'overlay';
  useEffect(() => {
    if (!isHome) { setRailByPointer(false); return; }
    let leaveTimer = 0;
    let inside = false;
    const update = (now: boolean) => {
      if (now === inside) return;
      inside = now;
      window.clearTimeout(leaveTimer);
      if (now) { setRailDismissed(false); setRailByPointer(true); }
      else leaveTimer = window.setTimeout(() => setRailByPointer(false), RAIL_POINTER_LEAVE);
    };
    const moved = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      const stage = rail.current?.parentElement?.getBoundingClientRect();
      if (!stage) return;
      const scale = stage.width / STAGE_WIDTH;
      const width = (railShown.current ? RAIL_EXPANDED : RAIL_EDGE) * scale;
      update(event.clientX >= stage.left && event.clientX - stage.left < width);
    };
    const left = () => update(false);
    window.addEventListener('pointermove', moved);
    document.documentElement.addEventListener('mouseleave', left);
    return () => {
      window.clearTimeout(leaveTimer);
      window.removeEventListener('pointermove', moved);
      document.documentElement.removeEventListener('mouseleave', left);
    };
  }, [isHome]);

  // Idle home: rail and album row hide, and focus leaves them so no ring is left on screen.
  useEffect(() => {
    if (!activity.active) { setRailDismissed(false); setRailByKey(false); setRailByPointer(false); }
    if (!isHome || activity.active || viewerOpen) return;
    const root = content.current;
    const active = document.activeElement;
    // The hidden row or rail may have taken the focused button with it, leaving focus on <body>.
    if (root && active !== root && (!active || active === document.body || root.contains(active) || rail.current?.contains(active)))
      root.focus({ preventScroll: true });
  }, [isHome, activity.active, viewerOpen]);

  // First key on idle home: show the rail and album row now (not after an effect, so a quick second
  // key already lands on them) and focus the row's first button, or All albums.
  function revealRow() {
    flushSync(() => { activity.wake(); setRailDismissed(false); setRailByKey(true); });
    content.current?.querySelector<HTMLElement>('.album-row button, [data-album="__all"]')?.focus();
  }

  // Leaving the viewer by any route (Back, Home, browser back) also leaves fullscreen.
  useEffect(() => {
    if (!viewerOpen && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, [viewerOpen]);

  // ---- Navigation
  // Commands read the live URL rather than the last rendered location, so a key that arrives between
  // a navigation and its render (remote messages, very fast key repeat) still acts on the new screen.
  const live = () => ({ pathname: window.location.pathname, search: window.location.search,
    home: window.location.pathname === '/', viewer: new URLSearchParams(window.location.search).has('photo') });
  const historyIndex = () => (window.history.state as { idx?: number } | null)?.idx ?? 0;
  function back() {
    const now = live();
    if (historyIndex() > 0) navigate(-1);
    else if (!now.home) navigate(parentPath(now.pathname), { replace: true });
    else if (activity.active) { activity.sleep(); content.current?.focus({ preventScroll: true }); }
  }
  function goHome() {
    const now = live();
    if (now.home && !now.viewer) { revealRow(); return; }
    // Home from an album returns to that album's button on the home screen.
    const album = /^\/photos\/([^/]+)/.exec(now.pathname)?.[1];
    navigate('/', { state: { focus: album ? `album:${decodeURIComponent(album)}` : undefined } });
  }
  function go(path: string) {
    const now = live();
    if (path === now.pathname && !now.search) { focusContent(); return; }
    navigate(path);
  }
  const openAlbum = (album: Album) => go(`/photos/${encodeURIComponent(album.id)}`);
  function openPhoto(albumId: string, photo: Photo | undefined) {
    if (!photo) return;
    navigate(`/photos/${encodeURIComponent(albumId)}?photo=${encodeURIComponent(photo.id)}`);
    // Request in the user gesture; the overlay still fills the stage where TV browsers deny fullscreen.
    if (!document.fullscreenElement && document.documentElement.requestFullscreen)
      void document.documentElement.requestFullscreen().catch(() => {});
  }
  function closeViewer() {
    if (historyIndex() > 0) navigate(-1);
    else navigate(live().pathname, { replace: true });
  }

  // ---- One command path for keyboard, remote buttons and the paired phone
  function command(value: Command) {
    if (isEditing(document.activeElement) && !(document.activeElement instanceof HTMLSelectElement)) return;
    cancelRestore.current(); // the user (keyboard, remote or phone) has taken over
    const wasIdle = activity.wake();
    if (value === 'Home') { goHome(); return; }
    if (document.querySelector('.slideshow')) { window.dispatchEvent(new CustomEvent('tv-command', { detail: value })); return; }
    if (value === 'Back') { back(); return; }
    const active = document.activeElement as HTMLElement | null;
    const zone = zoneOf(active, rail.current, content.current);
    const home = live().home;
    // On the idle home screen the first press only reveals the rail and the album row.
    if (home && (wasIdle || zone === 'none')) { revealRow(); return; }
    if (zone === 'none') { focusContent(); if (!content.current?.contains(document.activeElement)) focusRail(); return; }
    if (value === 'Up' || value === 'Down' || value === 'Left' || value === 'Right') {
      const key = `Arrow${value}`;
      if (zone === 'rail') {
        if (value === 'Right') focusContent();
        else moveFocus(rail.current!, key);
        return;
      }
      const moved = moveFocus(content.current!, key);
      if (!moved && value === 'Left' && (!home || activity.active)) focusRail();
      return;
    }
    if (value === 'Select') { active?.click(); return; }
    window.dispatchEvent(new CustomEvent(SCREEN_COMMAND, { detail: value }));
  }
  const latestCommand = useRef(command);
  latestCommand.current = command;
  const remote = useRemote('tv', value => latestCommand.current(value));

  // Keys are handled at the window so a mouse click on the letterbox or a photo never strands the keyboard.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const value = KEY_COMMANDS[event.key];
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const slideshow = document.querySelector<HTMLElement>('.slideshow');
      if (slideshow) {
        // The viewer handles its own keys; only rescue them when focus fell back to the page.
        if (value && (document.activeElement === document.body || !document.activeElement)) {
          event.preventDefault(); slideshow.focus(); latestCommand.current(value);
        }
        return;
      }
      if (isEditing(event.target) || !value) return;
      event.preventDefault();
      latestCommand.current(value);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return <div className={`dashboard shell${isHome ? ' is-home' : ''}${railMode === 'overlay' ? ' rail-open' : ''}`} hidden={viewerOpen} inert={viewerOpen}>
    <NavRail ref={rail} pathname={location.pathname} mode={railMode}
      onNavigate={path => { setRailDismissed(true); go(path); }} />
    <div className="screen" ref={content} tabIndex={-1}>
      <Routes>
        <Route path="/" element={<Home albums={albums.albums} expanded={activity.active} onOpenAlbum={openAlbum}
          onAllAlbums={() => go('/photos')} />} />
        <Route path="/photos" element={<PhotosScreen albums={albums} onOpenAlbum={openAlbum}
          onOpenPhoto={(album, photo) => openPhoto(album.id, photo)} />} />
        <Route path="/photos/:albumId" element={<AlbumScreen albums={albums} onOpenPhoto={openPhoto}
          onCloseViewer={closeViewer} onHome={goHome} />} />
        <Route path="/weather" element={<WeatherScreen />} />
        <Route path="/home-automation" element={<HomeAutomationScreen />} />
        <Route path="/calendar" element={<PlaceholderScreen title="Calendar" message="No calendar is connected yet." />} />
        <Route path="/preferences" element={<PreferencesScreen remote={remote} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  </div>;
}
