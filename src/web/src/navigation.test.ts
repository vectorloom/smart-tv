import { describe, expect, it } from 'vitest';
import { shuffled, wrap } from './navigation';

describe('slideshow order', () => {
  it('wraps in both directions', () => { expect(wrap(3, 3)).toBe(0); expect(wrap(-1, 3)).toBe(2); });
  it('handles empty and single-photo collections', () => { expect(wrap(1, 0)).toBe(0); expect(wrap(-1, 1)).toBe(0); });
  it('shuffles without mutating or losing photos', () => {
    const source = ['a', 'b', 'c', 'd'];
    const result = shuffled(source, () => 0);
    expect(result).not.toEqual(source);
    expect([...result].sort()).toEqual(source);
    expect(source).toEqual(['a', 'b', 'c', 'd']);
  });
});

import { isEditing, moveFocus } from './navigation';
it('moves deterministically by geometry, stays at boundaries, and excludes disabled buttons', () => {
  const root = document.createElement('div');
  document.body.append(root);
  const buttons = Array.from({ length: 5 }, (_, i) => {
    const button = document.createElement('button'); root.append(button);
    button.getBoundingClientRect = () => ({ left: (i % 2) * 200, top: Math.floor(i / 2) * 100, width: 100, height: 60 } as DOMRect);
    return button;
  });
  buttons[4].disabled = true;
  buttons[0].focus(); moveFocus(root, 'ArrowRight'); expect(buttons[1]).toHaveFocus();
  moveFocus(root, 'ArrowRight'); expect(buttons[1]).toHaveFocus();
  moveFocus(root, 'ArrowDown'); expect(buttons[3]).toHaveFocus();
  moveFocus(root, 'ArrowLeft'); expect(buttons[2]).toHaveFocus();
  moveFocus(root, 'ArrowDown'); expect(buttons[2]).toHaveFocus();
  root.remove();
});
it('recognizes text inputs, selects, and editable content', () => {
  for (const name of ['input', 'textarea', 'select']) expect(isEditing(document.createElement(name))).toBe(true);
  const editable = document.createElement('div'); editable.contentEditable = 'true'; editable.setAttribute('contenteditable', 'true');
  expect(isEditing(editable)).toBe(true);
  expect(isEditing(document.createElement('button'))).toBe(false);
});
