import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';

/** Reference canvas: every TV screen is designed in CSS px at 1920×1080. */
export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;

/** Uniform scale that fits the reference canvas inside the viewport (letterboxed if not 16:9). */
export function stageScale(width: number, height: number): number {
  return Math.min(width / STAGE_WIDTH, height / STAGE_HEIGHT);
}

/**
 * Fixed 1920×1080 canvas scaled to the real viewport. Android TV browsers often report
 * 1280×720 or 960×540; the layout and type sizes stay identical, only the scale changes.
 * The scale is computed in JS because CSS length division (100vw / 1920px) is too new for
 * the Chromium builds these boxes ship.
 */
const StageContext = createContext<HTMLElement | null>(null);
/** The stage element, for overlays (the full-screen viewer) that must sit above every screen. */
export const useStageElement = () => useContext(StageContext);

export function Stage({ children }: { children: ReactNode }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    // The layout viewport (excluding any scrollbar) is what the fixed stage is centred in.
    const apply = () => root.style.setProperty('--stage-scale',
      String(stageScale(root.clientWidth || window.innerWidth, root.clientHeight || window.innerHeight)));
    root.classList.add('tv');
    apply();
    // Window resize alone misses some changes (fullscreen, restored tabs, zoom on some browsers),
    // so every viewport signal re-applies the scale.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    observer?.observe(root);
    const events = ['resize', 'orientationchange', 'pageshow', 'fullscreenchange'] as const;
    events.forEach(name => window.addEventListener(name, apply));
    document.addEventListener('fullscreenchange', apply);
    window.visualViewport?.addEventListener('resize', apply);
    return () => {
      observer?.disconnect();
      events.forEach(name => window.removeEventListener(name, apply));
      document.removeEventListener('fullscreenchange', apply);
      window.visualViewport?.removeEventListener('resize', apply);
      root.classList.remove('tv'); root.style.removeProperty('--stage-scale');
    };
  }, []);
  return <div className="stage" ref={setElement}><StageContext.Provider value={element}>{children}</StageContext.Provider></div>;
}
