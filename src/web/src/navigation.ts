export function wrap(index: number, count: number): number {
  return count === 0 ? 0 : ((index % count) + count) % count;
}

export function shuffled<T>(items: readonly T[], random = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Geometry-based focus navigation adapts to the actual number of TV grid columns.
export function moveFocus(root: HTMLElement, key: string): void {
  const elements = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), select, [tabindex="0"]')]
    .filter(element => element.getBoundingClientRect().width > 0);
  const current = document.activeElement as HTMLElement;
  if (!elements.includes(current)) { elements[0]?.focus(); return; }
  const origin = current.getBoundingClientRect();
  const x = origin.left + origin.width / 2;
  const y = origin.top + origin.height / 2;
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const sign = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  const candidates = elements.filter(element => element !== current).map(element => {
    const rect = element.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 - x;
    const dy = rect.top + rect.height / 2 - y;
    const forward = (horizontal ? dx : dy) * sign;
    const cross = Math.abs(horizontal ? dy : dx);
    return { element, forward, score: forward + cross * 3 };
  }).filter(candidate => candidate.forward > 4).sort((a, b) => a.score - b.score);
  candidates[0]?.element.focus();
}

export function isEditing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}
