import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Slideshow } from './Slideshow';

const photos = [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }, { id: 'three', name: 'Three' }];
function setup(initialId = 'one', reveal = false) {
  const onExit = vi.fn();
  const view = render(<Slideshow album="album" photos={photos} initialId={initialId} onExit={onExit} />);
  const dialog = screen.getByRole('dialog');
  if (reveal) fireEvent.keyDown(dialog, { key: 'Enter' });
  return { dialog, onExit, unmount: view.unmount };
}

describe('slideshow controls', () => {
  it('opens the selected photo and wraps with arrow keys', () => {
    const { dialog } = setup('three');
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'Three');
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'One');
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'Three');
  });
  it('advances after load, pauses and resumes with Space', () => {
    vi.useFakeTimers();
    const { dialog } = setup();
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'One');
    fireEvent.load(screen.getByRole('img', { hidden: true }));
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'Two');
    fireEvent.load(screen.getByRole('img', { hidden: true }));
    fireEvent.keyDown(dialog, { key: ' ' });
    act(() => vi.advanceTimersByTime(16000));
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'Two');
    fireEvent.keyDown(dialog, { key: ' ' });
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'Three');
  });
  it('changes interval and supports previous and next buttons', () => {
    vi.useFakeTimers(); setup('one', true);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '3' } });
    fireEvent.load(screen.getByRole('img', { hidden: true }));
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'Two');
    fireEvent.click(screen.getByRole('button', { name: 'Previous photo' }));
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'One');
    fireEvent.click(screen.getByRole('button', { name: 'Next photo' }));
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'Two');
  });
  it('keeps the current photo when toggling shuffle', () => {
    setup('two', true);
    const button = screen.getByRole('button', { name: /Shuffle/ });
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'Two');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'Two');
  });
  it('exits with Escape and Backspace', () => {
    const { dialog, onExit } = setup();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.keyDown(dialog, { key: 'Backspace' });
    expect(onExit).toHaveBeenCalledTimes(2);
  });
  it('keeps Tab and directional focus on the photo frame', () => {
    const { dialog } = setup();
    for (const key of ['Tab', 'ArrowUp', 'ArrowDown']) {
      fireEvent.keyDown(dialog, { key });
      expect(dialog).toHaveFocus();
    }
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(dialog).toHaveFocus();
  });
  it('supports phone navigation, pause, select, and Back without visible controls', () => {
    vi.useFakeTimers();
    const { onExit } = setup();
    const command = (detail: string) => act(() => {
      window.dispatchEvent(new CustomEvent('tv-command', { detail }));
    });
    command('Right');
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'Two');
    command('Previous');
    command('PlayPause');
    fireEvent.load(screen.getByRole('img', { hidden: true }));
    act(() => vi.advanceTimersByTime(16000));
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'One');
    command('Select');
    expect(screen.getByRole('combobox')).toBeVisible();
    command('PlayPause');
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'Two');
    command('Back');
    expect(onExit).toHaveBeenCalledOnce();
  });
  it('continues playback past a failed image', () => {
    vi.useFakeTimers(); setup();
    fireEvent.error(screen.getByRole('img', { hidden: true }));
    expect(screen.getByRole('status', { hidden: true })).toHaveTextContent('unavailable');
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'Two');
  });
  it('recognizes an already completed image without a load event', () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(40);
    setup();
    expect(screen.queryByRole('status', { hidden: true })).not.toBeInTheDocument();
  });
  it('bounds a decode promise that never settles and advances after the error', () => {
    vi.useFakeTimers();
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true, value: () => new Promise<void>(() => {}),
    });
    try {
      setup();
      act(() => vi.advanceTimersByTime(15000));
      expect(screen.getByRole('status', { hidden: true })).toHaveTextContent('took too long');
      act(() => vi.advanceTimersByTime(8000));
      expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'Two');
    } finally { Reflect.deleteProperty(HTMLImageElement.prototype, 'decode'); }
  });
  it('ignores a late decode completion from the slide left by manual Next', async () => {
    let resolveOld!: () => void;
    const oldDecode = new Promise<void>(resolve => { resolveOld = resolve; });
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: vi.fn().mockReturnValueOnce(oldDecode).mockReturnValue(new Promise<void>(() => {})),
    });
    try {
      setup('one', true);
      fireEvent.click(screen.getByRole('button', { name: 'Next photo' }));
      await act(async () => { resolveOld(); await oldDecode; });
      expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('alt', 'Two');
      expect(screen.getByRole('status', { hidden: true })).toHaveTextContent('Loading');
      fireEvent.load(screen.getByRole('img', { hidden: true }));
      expect(screen.queryByRole('status', { hidden: true })).not.toBeInTheDocument();
    } finally { Reflect.deleteProperty(HTMLImageElement.prototype, 'decode'); }
  });
});

it('preserves native interval editing but always handles Backspace to exit', () => {
  const { dialog, onExit } = setup('one', true);
  const select = screen.getByRole('combobox'); select.focus();
  fireEvent.keyDown(select, { key: 'Home' });
  fireEvent.keyDown(select, { key: ' ' });
  expect(onExit).not.toHaveBeenCalled();
  fireEvent.keyDown(select, { key: 'Backspace' });
  expect(onExit).toHaveBeenCalledOnce();
  dialog.focus(); fireEvent.keyDown(dialog, { key: 'Home' });
  expect(onExit).toHaveBeenCalledTimes(2);
});

it('toggles the controls with Select without also pausing', () => {
  const { dialog } = setup();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  fireEvent.keyDown(dialog, { key: 'Enter' });
  expect(screen.getByRole('combobox')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Pause slideshow' })).toBeVisible();
  fireEvent.keyDown(dialog, { key: 'Enter', repeat: true });
  expect(screen.getByRole('combobox')).toBeVisible();
  fireEvent.keyDown(dialog, { key: 'Enter' });
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(dialog).toHaveFocus();
});

it('resets the five-second timeout on interaction and restores focus before hiding', () => {
  vi.useFakeTimers();
  const { dialog } = setup('one', true);
  fireEvent.keyDown(dialog, { key: 'ArrowDown' });
  const pause = screen.getByRole('button', { name: 'Pause slideshow' });
  expect(pause).toHaveFocus();
  act(() => vi.advanceTimersByTime(4000));
  fireEvent.click(pause);
  act(() => vi.advanceTimersByTime(4999));
  expect(screen.getByRole('button', { name: 'Play slideshow' })).toBeVisible();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(dialog).toHaveFocus();
  fireEvent.focus(window);
  fireEvent.keyDown(dialog, { key: 'ArrowRight' });
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});

it('keeps interval editing visible and restarts timeout after focus leaves', () => {
  vi.useFakeTimers();
  const { dialog } = setup('one', true);
  const select = screen.getByRole('combobox');
  act(() => select.focus());
  act(() => vi.advanceTimersByTime(20000));
  expect(select).toBeVisible();
  act(() => window.dispatchEvent(new CustomEvent('tv-command', { detail: 'Down' })));
  expect(select).toHaveValue('15');
  act(() => window.dispatchEvent(new CustomEvent('tv-command', { detail: 'Up' })));
  expect(select).toHaveValue('8');
  act(() => screen.getByRole('button', { name: /Shuffle/ }).focus());
  act(() => window.dispatchEvent(new CustomEvent('tv-command', { detail: 'Select' })));
  expect(screen.getByRole('button', { name: /Shuffle/ })).toHaveAttribute('aria-pressed', 'true');
  act(() => vi.advanceTimersByTime(5000));
  expect(select).not.toBeVisible();
  expect(dialog).toHaveFocus();
});

it('cleans up the inactivity timer on unmount', () => {
  vi.useFakeTimers();
  const scheduled = vi.spyOn(window, 'setTimeout');
  const cleared = vi.spyOn(window, 'clearTimeout');
  const { unmount } = setup('one', true);
  const timer = scheduled.mock.results[scheduled.mock.calls.findIndex(call => call[1] === 5000)].value;
  unmount();
  expect(cleared).toHaveBeenCalledWith(timer);
});
