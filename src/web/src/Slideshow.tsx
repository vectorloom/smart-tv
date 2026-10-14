import { useCallback, useEffect, useRef, useState } from 'react';
import { imageUrl, type Photo } from './api';
import { isEditing, moveFocus, shuffled, wrap } from './navigation';

type Props = { album: string; photos: Photo[]; initialId: string; onExit: () => void; onHome?: () => void };

// A keyed instance owns readiness and timers for exactly one displayed photo.
// Late decode completions cannot update the next slide or restart its timer.
function SlideImage({ src, name, playing, interval, advance }: {
  src: string; name: string; playing: boolean; interval: number; advance: () => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const image = imageRef.current!;
    let settled = false;
    const finish = (next: 'ready' | 'error') => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      setStatus(next);
    };
    const timeout = window.setTimeout(() => finish('error'), 15000);
    const loaded = () => finish('ready');
    const failed = () => finish('error');
    image.addEventListener('load', loaded);
    image.addEventListener('error', failed);
    // decode() also observes completion when a cached image's load event was missed.
    // Older TV browsers fall back to load/error plus the complete check.
    if (typeof image.decode === 'function') {
      void image.decode().then(loaded, failed);
    } else if (image.complete) {
      finish(image.naturalWidth > 0 ? 'ready' : 'error');
    }
    return () => {
      settled = true;
      window.clearTimeout(timeout);
      image.removeEventListener('load', loaded);
      image.removeEventListener('error', failed);
    };
  }, [src]);

  useEffect(() => {
    if (!playing || status === 'loading') return;
    const timer = window.setTimeout(advance, interval * 1000);
    return () => window.clearTimeout(timer);
  }, [playing, status, interval, advance]);

  return <>
    <img ref={imageRef} className="slide-image" src={src} alt={name} style={{ visibility: status === 'ready' ? 'visible' : 'hidden' }} />
    {status !== 'ready' && <div className="slide-message" role="status">{status === 'error'
      ? 'This photo is unavailable or took too long to load. Use Next or Previous to continue.'
      : 'Loading photo…'}</div>}
  </>;
}

export function Slideshow({ album, photos, initialId, onExit, onHome }: Props) {
  const [order, setOrder] = useState(photos);
  const [index, setIndex] = useState(Math.max(0, photos.findIndex(photo => photo.id === initialId)));
  const [playing, setPlaying] = useState(true);
  const [interval, setIntervalSeconds] = useState(8);
  const [shuffle, setShuffle] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const [controlsVisible, setControlsVisible] = useState(false);
  const controlsTimer = useRef<number | undefined>(undefined);
  const hideControls = useCallback(() => {
    // Move focus before hiding its owner, so keys always reach the photo frame.
    root.current?.focus();
    window.clearTimeout(controlsTimer.current);
    setControlsVisible(false);
  }, []);
  const resetControlsTimer = useCallback(() => {
    window.clearTimeout(controlsTimer.current);
    if (!controlsVisible) return;
    controlsTimer.current = window.setTimeout(() => {
      // Native select menus may consume keys without sending DOM events. Treat
      // the entire focused interval interaction as editing, including its popup.
      if (document.activeElement instanceof HTMLSelectElement && controls.current?.contains(document.activeElement)) return;
      hideControls();
    }, 5000);
  }, [controlsVisible, hideControls]);
  useEffect(() => {
    resetControlsTimer();
    return () => window.clearTimeout(controlsTimer.current);
  }, [resetControlsTimer]);

  function toggleControls() {
    if (controlsVisible) hideControls();
    else setControlsVisible(true);
  }
  function direction(key: string) {
    if (document.activeElement === root.current) {
      if (key === 'ArrowLeft' || key === 'ArrowRight') advance(key === 'ArrowLeft' ? -1 : 1);
      else if (controlsVisible) controls.current?.querySelector<HTMLButtonElement>('.primary')?.focus();
    } else if (controlsVisible) moveFocus(controls.current!, key);
  }
  const photo = order[index];
  const advance = (delta: number) => setIndex(value => wrap(value + delta, order.length));
  const nextPhoto = useCallback(() => setIndex(value => wrap(value + 1, order.length)), [order.length]);

  useEffect(() => { root.current?.focus(); }, []);
  useEffect(() => {
    if (order.length < 2) return;
    [1, -1].forEach(delta => {
      const image = new Image();
      image.src = imageUrl(album, order[wrap(index + delta, order.length)].id, 'preview');
    });
    // Do not cancel a preload as that same URL becomes the displayed image.
    // Prefetching is advisory; playback never waits for a preload promise.
  }, [album, index, order]);
  useEffect(() => {
    const changed = () => { if (!document.fullscreenElement) onExit(); };
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, [onExit]);

  useEffect(() => {
    const receive = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      resetControlsTimer();
      const active = document.activeElement;
      if (active instanceof HTMLSelectElement && (command === 'Up' || command === 'Down')) {
        active.selectedIndex = Math.max(0, Math.min(active.options.length - 1, active.selectedIndex + (command === 'Up' ? -1 : 1)));
        active.dispatchEvent(new Event('change', { bubbles: true })); return;
      }
      if (command === 'Back') onExit();
      else if (command === 'Next' || command === 'Previous') advance(command === 'Next' ? 1 : -1);
      else if (command === 'PlayPause') setPlaying(value => !value);
      else if (command === 'Select') {
        if (document.activeElement === root.current) toggleControls();
        else (document.activeElement as HTMLElement)?.click();
      } else if (['Up', 'Down', 'Left', 'Right'].includes(command)) {
        direction(`Arrow${command}`);
      }
    };
    window.addEventListener('tv-command', receive);
    return () => window.removeEventListener('tv-command', receive);
  });

  function toggleShuffle() {
    const next = shuffle ? photos : shuffled(photos);
    setIndex(Math.max(0, next.findIndex(item => item.id === photo?.id)));
    setOrder(next);
    setShuffle(value => !value);
  }

  return <div className="slideshow" role="dialog" aria-modal="true" aria-label="Photo slideshow" tabIndex={-1} ref={root}
    onFocusCapture={resetControlsTimer} onClickCapture={resetControlsTimer}
    onPointerDownCapture={resetControlsTimer} onPointerUpCapture={resetControlsTimer}
    onKeyUp={resetControlsTimer}
    onKeyDown={event => {
      resetControlsTimer();
      if (event.key === 'Escape' || event.key === 'Backspace') { event.preventDefault(); onExit(); return; }
      if (event.key === 'Tab') {
        event.preventDefault();
        const targets: HTMLElement[] = [root.current!, ...(controlsVisible
          ? controls.current!.querySelectorAll<HTMLElement>('button, select') : [])];
        const at = targets.indexOf(document.activeElement as HTMLElement);
        targets[wrap(at + (event.shiftKey ? -1 : 1), targets.length)].focus(); return;
      }
      // Lateral keys leave the interval selector; Up/Down retain native editing.
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); direction(event.key); return;
      }
      if (isEditing(event.target)) return;
      if (event.key === 'Home') { event.preventDefault(); (onHome ?? onExit)(); return; }
      if (event.key === ' ' && event.target === root.current) { event.preventDefault(); setPlaying(value => !value); }
      else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault(); direction(event.key);
      } else if (event.key === 'Enter' && event.target === root.current) {
        event.preventDefault(); if (!event.repeat) toggleControls();
      }
    }}>
    {photo && <SlideImage key={`${album}/${photo.id}`} src={imageUrl(album, photo.id, 'preview')}
      name={photo.name} playing={playing && order.length > 1} interval={interval} advance={nextPhoto} />}
    <div className="slide-top"><span className="wordmark">still<span> / </span>moments</span><button onClick={onExit}>✕ <span>Exit</span></button></div>
    <div className="slide-bottom" hidden={!controlsVisible}>
      <div className="slide-caption"><span>{photo?.name}</span><span>{index + 1} / {order.length}</span></div>
      <div className="slide-controls" ref={controls}>
        <button onClick={() => advance(-1)} aria-label="Previous photo">←</button>
        <button className="primary" onClick={() => setPlaying(value => !value)} aria-label={playing ? 'Pause slideshow' : 'Play slideshow'}>{playing ? 'Ⅱ Pause' : '▶ Play'}</button>
        <button onClick={() => advance(1)} aria-label="Next photo">→</button>
        <label className="interval">Interval <select aria-label="Slide interval" value={interval} onChange={event => { setIntervalSeconds(Number(event.target.value)); resetControlsTimer(); }}>
          {[3, 5, 8, 15, 30, 60].map(value => <option key={value} value={value}>{value}s</option>)}
        </select></label>
        <button aria-pressed={shuffle} onClick={toggleShuffle}>⇄ Shuffle {shuffle ? 'on' : 'off'}</button>
        <button onClick={hideControls}>Hide controls</button>
      </div>
      <p className="key-hint">← → photos <span>·</span> Space play / pause <span>·</span> ↑ ↓ controls <span>·</span> Esc exit</p>
    </div>
  </div>;
}
