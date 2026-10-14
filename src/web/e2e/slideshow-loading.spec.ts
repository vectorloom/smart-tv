import { test, expect, type Page } from '@playwright/test';

async function gallery(page: Page, mode: 'missed-load' | 'slow') {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 40;
    canvas.getContext('2d')!.fillRect(0, 0, 40, 40);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  });
  if (mode === 'missed-load') await page.addInitScript(() => {
    // Reproduce a completion notification missed by the slideshow, after two good slides.
    document.addEventListener('load', event => {
      const image = event.target;
      if (image instanceof HTMLImageElement && image.className === 'slide-image' && image.src.includes('/three/'))
        event.stopImmediatePropagation();
    }, true);
  });
  let release: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/image')) {
      if (mode === 'slow' && url.pathname.includes('/three/') && url.searchParams.get('size') === 'preview') await blocked;
      return route.fulfill({ contentType: 'image/jpeg', body: Buffer.from(jpeg, 'base64') });
    }
    if (url.pathname.endsWith('/photos')) return route.fulfill({ json: {
      items: ['one', 'two', 'three', 'four', 'five'].map(id => ({ id, name: id })), nextPage: null,
    } });
    return route.fulfill({ json: [{ id: 'album', name: 'Five photos', assetCount: 5 }] });
  });
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: /Five photos/ }).click();
  await page.getByRole('button', { name: 'Play album' }).click();
  return { errors, release: () => release!() };
}

test('advances automatically through five JPEGs when the third load notification is missed', async ({ page }) => {
  const { errors } = await gallery(page, 'missed-load');
  for (const name of ['one', 'two', 'three', 'four', 'five']) {
    await expect(page.getByRole('dialog').getByRole('img', { includeHidden: true })).toHaveAttribute('alt', name);
    await expect(page.getByRole('dialog').getByRole('status', { includeHidden: true })).toHaveCount(0);
    await expect(page.locator('.slide-top')).toBeHidden();
    await expect(page.locator('.slide-bottom')).toBeHidden();
    await expect(page.locator('.slide-message')).toBeHidden();
    await page.clock.runFor(8000);
  }
  await expect(page.getByRole('dialog').getByRole('img', { includeHidden: true })).toHaveAttribute('alt', 'one');
  expect(errors).toEqual([]);
});

test('Next and Previous recover while loading; a slow image times out and playback continues', async ({ page }) => {
  const { errors, release } = await gallery(page, 'slow');
  try {
    await expect(page.getByRole('dialog').getByRole('status', { includeHidden: true })).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('dialog').getByRole('status', { includeHidden: true })).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('status', { includeHidden: true })).toHaveText(/Loading/);
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('dialog').getByRole('img', { includeHidden: true })).toHaveAttribute('alt', 'four');
    await expect(page.getByRole('dialog').getByRole('status', { includeHidden: true })).toHaveCount(0);
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('status', { includeHidden: true })).toHaveText(/Loading/);
    await page.clock.runFor(15000);
    await expect(page.getByRole('status', { includeHidden: true })).toHaveText(/unavailable/);
    await expect(page.locator('.slide-top')).toBeHidden();
    await expect(page.locator('.slide-bottom')).toBeHidden();
    await expect(page.locator('.slide-message')).toBeHidden();
    await page.clock.runFor(8000);
    await expect(page.getByRole('dialog').getByRole('img', { includeHidden: true })).toHaveAttribute('alt', 'four');
    await expect(page.getByRole('dialog').getByRole('status', { includeHidden: true })).toHaveCount(0);
    release();
    await expect(page.locator('.slide-top')).toBeHidden();
    await expect(page.locator('.slide-bottom')).toBeHidden();
    await expect(page.locator('.slide-message')).toBeHidden();
    await page.clock.runFor(8000);
    await expect(page.getByRole('dialog').getByRole('img', { includeHidden: true })).toHaveAttribute('alt', 'five');
    expect(errors).toEqual([]);
  } finally { release(); }
});
