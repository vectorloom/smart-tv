import { useCallback, useEffect, useRef, useState } from 'react';

/** Controls revealed by input (home album list, navigation rail) hide again after this much quiet. */
export const IDLE_AFTER = 30_000;

/**
 * Tracks whether someone is using the TV. `wake()` is called for every key and remote command and
 * returns true when the screen was idle, so the caller can spend that first press on revealing
 * controls instead of acting on it. Mouse movement, clicks and wheel also count, so a PC behaves
 * like the remote. After `timeout` without input the screen goes idle again.
 */
export function useActivity(timeout = IDLE_AFTER) {
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const timer = useRef(0);

  const sleep = useCallback(() => {
    window.clearTimeout(timer.current);
    activeRef.current = false;
    setActive(false);
  }, []);
  const wake = useCallback(() => {
    const wasIdle = !activeRef.current;
    activeRef.current = true;
    setActive(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(sleep, timeout);
    return wasIdle;
  }, [sleep, timeout]);

  useEffect(() => {
    let last: { x: number; y: number } | null = null;
    // Browsers also fire pointer moves when a page loads or content changes under a still cursor.
    // The first one only records where the cursor rests; after that, only real movement counts.
    const moved = (event: PointerEvent) => {
      const at = { x: event.clientX, y: event.clientY };
      if (event.pointerType === 'mouse' && (!last || Math.hypot(at.x - last.x, at.y - last.y) < 4)) { last ??= at; return; }
      last = at;
      wake();
    };
    const touched = () => { wake(); };
    window.addEventListener('pointermove', moved);
    window.addEventListener('pointerdown', touched);
    window.addEventListener('wheel', touched, { passive: true });
    return () => {
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('pointerdown', touched);
      window.removeEventListener('wheel', touched);
      window.clearTimeout(timer.current);
    };
  }, [wake]);

  return { active, wake, sleep };
}
