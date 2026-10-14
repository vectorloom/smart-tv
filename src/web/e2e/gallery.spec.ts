import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/image')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#35493b"/><circle cx="1300" cy="350" r="130" fill="#d7ecab"/><path d="M0 1080L650 400L1300 1080Z" fill="#718465"/></svg>' });
    if (path.endsWith('/photos')) return route.fulfill({ json: { items: [{ id: 'one', name: 'Mountain morning' }, { id: 'two', name: 'Quiet afternoon' }], nextPage: null } });
    return route.fulfill({ json: [{ id: 'album', name: 'Weekend wanderings', assetCount: 2 }, { id: 'second', name: 'Everyday favorites', assetCount: 12 }] });
  });
});

test('TV remote navigation, photo frame presentation, and focus restoration', async ({ page }) => {
  await page.goto('/');
  const album = page.getByRole('button', { name: /Weekend wanderings/ });
  await expect(album).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: /Everyday favorites/ })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Play album' })).toBeEnabled();
  await page.getByRole('button', { name: 'Open Mountain morning' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Mountain morning', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('img', { name: 'Quiet afternoon', exact: true })).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.locator('.slide-controls button.primary')).toHaveAttribute('aria-label', 'Play slideshow');
  for (const selector of ['.dashboard', '.slide-top', '.slide-bottom', '.slide-message']) {
    await expect(page.locator(selector)).toBeHidden();
  }
  await expect(page.locator('.slide-image')).toHaveCSS('object-fit', 'contain');
  for (const key of ['Tab', 'Shift+Tab', 'ArrowUp', 'ArrowDown']) {
    await page.keyboard.press(key);
    await expect(page.getByRole('dialog')).toBeFocused();
  }
  await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('img', { name: 'Mountain morning', exact: true })).toBeVisible();
  await expect(page.locator('.slide-top')).toBeHidden();
  await expect(page.locator('.slide-bottom')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Mountain morning' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Weekend wanderings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pair phone', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/gallery-1080p.png', fullPage: true });
});

test('mobile layout fits the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Weekend wanderings/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('frame presentation and Backspace exit work when fullscreen is denied', async ({ page }) => {
  await page.addInitScript(() => {
    document.documentElement.requestFullscreen = () => Promise.reject(new Error('Fullscreen denied'));
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Weekend wanderings/ }).click();
  const play = page.getByRole('button', { name: 'Play album' });
  await play.click();
  await expect(page.getByRole('dialog')).toBeFocused();
  await expect(page.locator('.dashboard')).toBeHidden();
  await expect(page.locator('.slide-top')).toBeHidden();
  await expect(page.locator('.slide-bottom')).toBeHidden();
  await page.keyboard.press('Backspace');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(play).toBeVisible();
  await expect(play).toBeFocused();
});

test('Select reveals reusable TV controls, interval editing survives timeout, and hiding restores focus', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: /Weekend wanderings/ }).click();
  await page.getByRole('button', { name: 'Play album' }).click();
  const dialog = page.getByRole('dialog');
  const overlay = page.locator('.slide-bottom');
  await expect(overlay).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(overlay).toBeVisible();
  await expect(dialog).toBeFocused();
  for (const selector of ['.dashboard', '.slide-top', '.slide-caption', '.key-hint', '.slide-message']) {
    await expect(page.locator(selector)).toBeHidden();
  }
  await page.keyboard.press('Enter');
  await expect(overlay).toBeHidden();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Pause slideshow' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Play slideshow' })).toBeFocused();
  await expect(overlay).toBeVisible();
  await page.clock.runFor(8000);
  await expect(overlay).toBeHidden();
  await expect(dialog).toBeFocused();
  await expect(dialog.getByRole('img')).toHaveAttribute('alt', 'Mountain morning');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Pause slideshow' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const interval = page.getByRole('combobox', { name: 'Slide interval' });
  await expect(interval).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(interval).toHaveValue('15');
  // A focused native selector may own a popup; never hide it on a timeout.
  await page.keyboard.press('Enter');
  await page.clock.runFor(6000);
  await expect(interval).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  const shuffle = page.getByRole('button', { name: /Shuffle/ });
  await expect(shuffle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
  await page.clock.runFor(4000);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Hide controls' })).toBeFocused();
  await page.clock.runFor(4000);
  await expect(overlay).toBeVisible();
  await page.clock.runFor(1000);
  await expect(overlay).toBeHidden();
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Hide controls' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(overlay).toBeHidden();
  await expect(dialog).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(overlay).toBeHidden();
  await page.keyboard.press('Backspace');
  await expect(page.getByRole('button', { name: 'Play album' })).toBeFocused();
});
