// Focus zones layered on navigation.ts: the shell has a rail zone and a content zone. Arrow keys move
// within a zone with moveFocus(); an edge press hands focus to the other zone.

export type Zone = 'rail' | 'content' | 'none';

/** Which zone holds focus. The content root itself (focused with no ring on idle home) counts as none. */
export function zoneOf(element: Element | null, rail: Element | null, content: Element | null): Zone {
  if (!element || element === document.body || element === content) return 'none';
  if (rail?.contains(element)) return 'rail';
  if (content?.contains(element)) return 'content';
  return 'none';
}

const focusable = 'button:not(:disabled), select:not(:disabled), [tabindex="0"]';

/**
 * The screen's preferred first focus: an enabled [data-autofocus], else its first focusable control.
 * Null while any part of the screen is still loading (aria-busy), so focus doesn't land on a
 * placeholder-adjacent control and then stay there when the real content arrives.
 */
export function defaultFocus(root: HTMLElement): HTMLElement | null {
  if (root.querySelector('[aria-busy="true"]')) return null;
  return root.querySelector<HTMLElement>(`[data-autofocus]:not(:disabled)`) ?? root.querySelector<HTMLElement>(focusable);
}

/** The enabled element carrying a remembered data-focus-key (compared as text, no selector escaping). */
export function findFocusKey(root: HTMLElement, key: string | undefined): HTMLElement | null {
  if (!key) return null;
  return [...root.querySelectorAll<HTMLElement>('[data-focus-key]')]
    .find(element => element.dataset.focusKey === key && !(element as HTMLButtonElement).disabled) ?? null;
}

/** Where Back goes when there is no in-app history (e.g. the TV opened a deep link): one level up. */
export function parentPath(pathname: string): string {
  const album = /^\/photos\/[^/]+/.exec(pathname);
  return album ? '/photos' : '/';
}

/** Commands the shell doesn't handle (PlayPause) go to the current screen as this window event. */
export const SCREEN_COMMAND = 'screen-command';
