import { test, expect, type Page } from '@playwright/test';

// A TV runs the slideshow for days. These runs make ~200 advances and check that nothing piles up:
// the DOM stays the same size, decoded <img> objects are released, and no object URL is left behind.

const svg = (n: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="960"><rect width="1440" height="960" fill="hsl(${(n * 37) % 360} 30% 35%)"/><circle cx="${400 + (n % 7) * 90}" cy="300" r="120" fill="#e8c38a"/></svg>`;
const viewerPhotos = Array.from({ length: 40 }, (_, i) => ({ id: `v${i + 1}`, name: `Photo ${i + 1}` }));

async function mockApi(page: Page) {
  await page.routeWebSocket(/\/api\/remote$/, () => {});
  let served = 0;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const image = /\/photos\/[a-z]*(\d+)\/image$/.exec(path);
    if (image) return route.fulfill({ contentType: 'image/svg+xml', body: svg(Number(image[1])) });
    if (path === '/api/slideshow/next') {
      served++;
      return route.fulfill({ json: { albumId: 'lake', albumName: 'Summer at the lake', photoId: `p${served}`,
        takenAt: '2024-07-04T18:30:00.000Z', index: served, total: 100000 } });
    }
    if (path === '/api/albums') return route.fulfill({ json: [{ id: 'lake', name: 'Summer at the lake', assetCount: viewerPhotos.length }] });
    if (path === '/api/albums/lake/photos') return route.fulfill({ json: { items: viewerPhotos, nextPage: null } });
    return route.fulfill({ status: 503, json: { message: 'not used here' } });
  });
}

/** Count object URLs that were created but never revoked. */
const trackObjectUrls = (page: Page) => page.addInitScript(() => {
  const live = new Set<string>();
  (window as unknown as { liveObjectUrls: Set<string> }).liveObjectUrls = live;
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (object: Blob | MediaSource) => { const url = create(object); live.add(url); return url; };
  URL.revokeObjectURL = (url: string) => { live.delete(url); revoke(url); };
});

/** Live HTMLImageElement objects after a forced garbage collection (DOM and detached preloads alike). */
async function liveImages(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const { result: prototype } = await cdp.send('Runtime.evaluate', { expression: 'HTMLImageElement.prototype' });
  const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.objectId! });
  const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objectId!, functionDeclaration: 'function () { return this.length; }', returnByValue: true });
  await cdp.detach();
  return result.value as number;
}

const domSize = (page: Page) => page.evaluate(() => ({
  nodes: document.getElementsByTagName('*').length,
  images: document.images.length,
  objectUrls: (window as unknown as { liveObjectUrls: Set<string> }).liveObjectUrls.size,
}));

test('home slideshow: 200 crossfades keep the DOM flat and release old images', async ({ page }) => {
  test.setTimeout(240_000);
  await trackObjectUrls(page);
  await page.clock.install({ time: new Date('2026-11-12T12:58:00') });
  await mockApi(page);
  await page.goto('/');
  const meta = page.locator('.photo-meta');
  await expect(meta).toContainText('of 100,000');
  // The position shown is "n of 100,000"; each crossfade must show the next one.
  const position = async () => Number((/([\d,]+) of 100,000/.exec(await meta.innerText())?.[1] ?? '0').replace(/,/g, ''));
  let shown = await position();
  const advance = async () => {
    await page.clock.runFor(30_000);
    shown++;
    await expect(meta).toContainText(`${shown.toLocaleString('en-US')} of 100,000`);
  };
  // Warm up past the first few slides (fonts, the second layer, caches) before taking the baseline.
  for (let i = 0; i < 5; i++) await advance();
  const before = await domSize(page);
  const imagesBefore = await liveImages(page);
  for (let i = 0; i < 200; i++) await advance();
  const after = await domSize(page);
  const imagesAfter = await liveImages(page);
  console.log(`home: nodes ${before.nodes}→${after.nodes}, live <img> ${imagesBefore}→${imagesAfter}`);
  expect(after.nodes).toBeLessThanOrEqual(before.nodes + 2);
  expect(after.images).toBe(2); // outgoing photo under the incoming one, nothing more
  expect(await page.locator('.photo-slide').count()).toBe(2);
  expect(imagesAfter).toBeLessThanOrEqual(imagesBefore + 3); // 200 preloads were created; they must not survive
  expect(after.objectUrls).toBe(0);
});

test('full-screen viewer: 200 advances keep the DOM flat and release old images', async ({ page }) => {
  test.setTimeout(240_000);
  await trackObjectUrls(page);
  await mockApi(page);
  await page.goto('/photos/lake');
  await page.getByRole('button', { name: 'Play album' }).click();
  const image = page.getByRole('dialog').getByRole('img', { includeHidden: true });
  await expect(image).toHaveAttribute('alt', 'Photo 1');
  let index = 0;
  const next = async () => {
    await page.keyboard.press('ArrowRight');
    index = (index + 1) % viewerPhotos.length;
    await expect(image).toHaveAttribute('alt', viewerPhotos[index].name);
  };
  for (let i = 0; i < 5; i++) await next();
  const before = await domSize(page);
  const imagesBefore = await liveImages(page);
  for (let i = 0; i < 200; i++) await next();
  const after = await domSize(page);
  const imagesAfter = await liveImages(page);
  console.log(`viewer: nodes ${before.nodes}→${after.nodes}, live <img> ${imagesBefore}→${imagesAfter}`);
  expect(after.nodes).toBeLessThanOrEqual(before.nodes + 2);
  // The album grid behind the viewer holds its thumbnails; the viewer itself adds one image.
  expect(after.images).toBe(before.images);
  expect(imagesAfter).toBeLessThanOrEqual(imagesBefore + 3);
  expect(after.objectUrls).toBe(0);
});
