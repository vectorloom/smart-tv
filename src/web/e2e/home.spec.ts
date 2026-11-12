import { test, expect, type Page } from '@playwright/test';

const albumList = (count: number) => Array.from({ length: count }, (_, i) => ({
  id: `album-${i}`, name: ['Weekend wanderings', 'Everyday favorites', 'Summer at the lake'][i] ?? `Album number ${i + 1}`,
  assetCount: 40 + i, thumbnailId: null,
}));

const hourly = Array.from({ length: 12 }, (_, i) => ({
  time: `2026-11-12T${String(12 + i).padStart(2, '0')}:00`.replace('T24', 'T00'), temperatureF: [71, 73, 74, 74, 72, 69, 66, 63, 61, 59, 57, 56][i],
  weatherCode: i < 6 ? 0 : 2, condition: 'Clear', precipitationProbability: i * 3,
}));
const daily = Array.from({ length: 7 }, (_, i) => ({
  date: `2026-11-${12 + i}`, highF: [74, 77, 68, 62, 70, 71, 72][i], lowF: [51, 55, 49, 44, 50, 52, 53][i],
  weatherCode: [0, 2, 61, 3, 95, 0, 1][i], condition: 'Clear', precipitationProbability: [0, 10, 70, 20, 40, 0, 5][i],
}));

type WeatherMode = 'live' | 'stale' | 'down';

async function mockApi(page: Page, albums = albumList(3), weather: WeatherMode = 'live') {
  // No real remote socket: these tests load many pages and pairing is covered in remote.spec.
  await page.routeWebSocket(/\/api\/remote$/, () => {});
  let served = 0;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/image')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="960"><rect width="1440" height="960" fill="#6b5a48"/><circle cx="1000" cy="300" r="120" fill="#e8c38a"/><path d="M0 960L520 380L1100 960Z" fill="#3f4a3c"/></svg>' });
    if (path === '/api/slideshow/next') {
      served++;
      return route.fulfill({ json: { albumId: albums[0].id, albumName: 'Summer at the lake house with the whole family', photoId: `photo-${served}`,
        takenAt: '2024-07-04T18:30:00.000Z', index: 12 + served, total: 1340 } });
    }
    if (path === '/api/weather') {
      // 'stale' is what the API now serves when Open-Meteo fails: the cached forecast with its own timestamp.
      if (weather === 'down') return route.fulfill({ status: 502, body: '' });
      return route.fulfill({ json: {
        location: 'Coppell', lastUpdated: '2026-11-12T18:14:00Z', stale: weather === 'stale',
        current: { time: '2026-11-12T12:00', temperatureF: 71.4, weatherCode: 0, condition: 'Clear', isDay: true,
          precipitationProbability: 0, relativeHumidity: 41, windSpeedMph: 12.2, windDirectionDegrees: 180, pressureHpa: 1012 },
        hourly, daily,
      } });
    }
    if (path === '/api/albums') return route.fulfill({ json: albums });
    if (path.endsWith('/photos')) return route.fulfill({ json: { items: [{ id: 'one', name: 'Mountain morning' }], nextPage: null } });
    return route.fulfill({ status: 404, json: { message: 'not found' } });
  });
}

/** Geometry of the scaled stage and everything on it, measured in the real browser. */
function measure(page: Page) {
  return page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('.stage')!.getBoundingClientRect();
    const scale = stage.width / 1920;
    const inside = (outer: DOMRect, inner: DOMRect) => inner.left >= outer.left - 1 && inner.top >= outer.top - 1 &&
      inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;
    const rail = document.querySelector('.rail')!;
    const railRect = rail.getBoundingClientRect();
    const home = document.querySelector('.home')!.getBoundingClientRect();
    const overflowing = [...rail.children, document.querySelector('.photo-stage')!]
      .filter(element => !inside(rail.contains(element) ? railRect : home, element.getBoundingClientRect()))
      .map(element => element.className);
    const tooSmall: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement | SVGElement>('.home *')) {
      const ownText = [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent!.trim());
      if (!ownText || element.getBoundingClientRect().width === 0) continue;
      const size = parseFloat(getComputedStyle(element).fontSize);
      // Effective on-screen size is the CSS size times the stage scale; it must be ≥ 16px × scale.
      if (size * scale < 16 * scale - 0.01) tooSmall.push(`${element.tagName}.${element.getAttribute('class')} ${size}px "${element.textContent!.trim().slice(0, 30)}"`);
    }
    const clock = document.querySelector('.clock')!.getBoundingClientRect();
    return {
      scale, expectedScale: Math.min(innerWidth / 1920, innerHeight / 1080),
      stage: { left: stage.left, top: stage.top, right: stage.right, bottom: stage.bottom, width: stage.width, height: stage.height },
      viewport: { width: innerWidth, height: innerHeight },
      scroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, bodyHeight: document.body.scrollHeight },
      clockInside: inside(stage, clock),
      railScrolls: rail.scrollHeight > rail.clientHeight + 1,
      letterbox: getComputedStyle(document.body).backgroundColor,
      overflowing, tooSmall,
    };
  });
}

function expectFullyVisible(result: Awaited<ReturnType<typeof measure>>) {
  const { stage, viewport } = result;
  expect(result.scale).toBeCloseTo(result.expectedScale, 3);
  // The whole 16:9 stage is inside the viewport: nothing is cropped on any side.
  expect(stage.left).toBeGreaterThanOrEqual(-0.5);
  expect(stage.top).toBeGreaterThanOrEqual(-0.5);
  expect(stage.right).toBeLessThanOrEqual(viewport.width + 0.5);
  expect(stage.bottom).toBeLessThanOrEqual(viewport.height + 0.5);
  expect(stage.width / stage.height).toBeCloseTo(16 / 9, 2);
  // It fills one axis and is centred on the other, with equal letterbox bars in the background colour.
  expect(Math.min(viewport.width - stage.width, viewport.height - stage.height)).toBeLessThan(1);
  expect(Math.abs(stage.left - (viewport.width - stage.right))).toBeLessThan(1);
  expect(Math.abs(stage.top - (viewport.height - stage.bottom))).toBeLessThan(1);
  expect(result.letterbox).toBe('rgb(15, 16, 18)');
  expect(result.clockInside).toBe(true);
  expect(result.scroll.width).toBeLessThanOrEqual(viewport.width);
  expect(result.scroll.height).toBeLessThanOrEqual(viewport.height);
  expect(result.scroll.bodyHeight).toBeLessThanOrEqual(viewport.height);
  expect(result.railScrolls).toBe(false);
  expect(result.overflowing).toEqual([]);
}

const viewports = [[1920, 1080], [1280, 720], [960, 540], [1892, 1013], [1366, 768], [1600, 1000]] as const;
for (const [width, height] of viewports) {
  test(`home fits ${width}×${height}: whole stage visible, no scrolling, text ≥16px at 1080p scale`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    // 12:58 PM is the widest clock reading.
    await page.clock.setFixedTime(new Date('2026-11-12T12:58:00'));
    await mockApi(page);
    await page.goto('/');
    await expect(page.locator('.photo-album')).toHaveText(/Summer at the lake/);
    await expect(page.locator('.wn-temp')).toHaveText('71°');
    await expect(page.locator('.day')).toHaveCount(5);
    await expect(page.locator('.chart-time')).toHaveText(['Now', '3 PM', '6 PM', '9 PM', '11 PM']);
    const result = await measure(page);
    expectFullyVisible(result);
    expect(result.tooSmall).toEqual([]);
    await page.screenshot({ path: `test-results/home-${width}x${height}.png`, animations: 'disabled' });
  });
}

test('stage re-fits when the window is resized after loading', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.locator('.wn-temp')).toHaveText('71°');
  for (const [width, height] of [[1892, 1013], [1600, 1000], [1366, 768], [2560, 1080], [1920, 1080]] as const) {
    await page.setViewportSize({ width, height });
    // The scale follows the viewport on the next resize callback; wait for it to settle.
    await expect.poll(async () => { const m = await measure(page); return Math.abs(m.scale - m.expectedScale); }).toBeLessThan(0.0005);
    expectFullyVisible(await measure(page));
  }
});

for (const [width, height] of [[1920, 1080], [1892, 1013]] as const) {
  for (const mode of ['live', 'stale', 'down'] as const) {
    test(`weather ${mode} at ${width}×${height}: every slot keeps its place`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.clock.setFixedTime(new Date('2026-11-12T12:58:00'));
      await mockApi(page, albumList(3), mode);
      await page.goto('/');
      await expect(page.locator('.photo-album')).toHaveText(/Summer at the lake/);
      const credit = page.locator('.rail-footer > span');
      if (mode === 'live') {
        await expect(page.locator('.wn-temp')).toHaveText('71°');
        await expect(credit).toHaveText(/^Weather by Open-Meteo · updated \d{1,2}:14 [AP]M$/);
      } else if (mode === 'stale') {
        // Open-Meteo is down: the server's cached forecast is shown with the time it was fetched.
        await expect(page.locator('.wn-temp')).toHaveText('71°');
        await expect(credit).toHaveText(/updated \d{1,2}:14 [AP]M · offline$/);
      } else {
        await expect(page.locator('.weather-now.is-placeholder .wn-temp')).toHaveText('—°');
        await expect(page.locator('.wn-summary')).toHaveText('Weather unavailable · retrying');
        await expect(credit).toHaveText('Weather by Open-Meteo · unavailable, retrying');
        await expect(page.locator('.hours-chart.is-placeholder .chart-time')).toHaveText(['Now', '3 PM', '6 PM', '9 PM', '11 PM']);
        await expect(page.locator('.days.is-placeholder .day')).toHaveCount(5);
      }
      // The chart and five-day slots are never collapsed or blank.
      const chart = (await page.locator('.hours-chart').boundingBox())!;
      const days = (await page.locator('.days').boundingBox())!;
      expect(chart.height).toBeGreaterThan(120 * (await measure(page)).scale);
      expect(days.height).toBeGreaterThan(100 * (await measure(page)).scale);
      // Labels under the chart never collide with the 5 DAYS heading.
      const lastTime = (await page.locator('.chart-time').first().boundingBox())!;
      const daysLabel = (await page.getByRole('heading', { name: '5 days' }).boundingBox())!;
      expect(lastTime.y + lastTime.height).toBeLessThanOrEqual(daysLabel.y);
      await page.screenshot({ path: `test-results/home-${width}x${height}-weather-${mode}.png`, animations: 'disabled' });
      const result = await measure(page);
      expectFullyVisible(result);
      expect(result.tooSmall).toEqual([]);
    });
  }
}

test('a browser that saw a forecast keeps showing it, with its time, when the API is unreachable', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-12T12:58:00'));
  await mockApi(page);
  await page.goto('/');
  await expect(page.locator('.wn-temp')).toHaveText('71°');
  await page.unroute('**/api/**');
  await mockApi(page, albumList(3), 'down');
  await page.reload();
  await expect(page.locator('.wn-temp')).toHaveText('71°');
  await expect(page.locator('.rail-footer > span')).toHaveText(/updated \d{1,2}:14 [AP]M · offline$/);
});

test('idle home shows one All albums button; the first key reveals a single album row', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  const all = page.getByRole('button', { name: 'All albums (3)' });
  await expect(all).toBeVisible();
  await expect(page.locator('.album-row')).toHaveCount(0);
  // Ambient screen: nothing is focused until the first key press, and that press only reveals the row.
  await expect(page.locator('.stage button:focus')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  const weekend = page.getByRole('button', { name: 'Weekend wanderings' });
  await expect(weekend).toBeFocused();
  const row = (await page.locator('.album-row').boundingBox())!;
  const pill = (await weekend.boundingBox())!;
  expect(row.height).toBeLessThan(pill.height * 1.6); // one row, not a wrapped block
  await expect(weekend).toHaveCSS('box-shadow', 'rgb(242, 163, 58) 0px 0px 0px 4px');
  await expect(weekend).toHaveCSS('transform', /matrix\(1\.04, 0, 0, 1\.04/);
  expect(pill.height).toBeGreaterThanOrEqual(48);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const lake = page.getByRole('button', { name: 'Summer at the lake' });
  await expect(lake).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Summer at the lake', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lake).toBeFocused();
  // Down reaches the All albums button; Back on home hides the row again.
  await page.keyboard.press('ArrowDown');
  await expect(all).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.album-row')).toHaveCount(0);
  await expect(page.locator('.stage button:focus')).toHaveCount(0);
});

test('the album row hides after 30 seconds without input', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-12T12:58:00') });
  await mockApi(page);
  await page.goto('/');
  await page.clock.runFor(500);
  await expect(page.getByRole('button', { name: 'All albums (3)' })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Weekend wanderings' })).toBeFocused();
  await page.clock.runFor(29_000);
  await expect(page.locator('.album-row')).toBeVisible();
  await page.clock.runFor(1_500);
  await expect(page.locator('.album-row')).toHaveCount(0);
  await expect(page.locator('.stage button:focus')).toHaveCount(0);
});

test('mouse and keyboard work like the remote on a PC', async ({ page }) => {
  await page.setViewportSize({ width: 1892, height: 1013 });
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'All albums (3)' })).toBeVisible();
  // Moving the mouse reveals the album row; clicking a pill opens the album like Enter.
  await page.mouse.move(400, 400);
  await page.mouse.move(420, 420);
  await page.getByRole('button', { name: 'Everyday favorites' }).click();
  await expect(page.getByRole('heading', { name: 'Everyday favorites', exact: true })).toBeVisible();
  // A click on the letterbox bar moves focus to the page; Escape still goes back.
  await page.mouse.click(5, 500);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Everyday favorites' })).toBeFocused();
  // After clicking the photo, arrows still navigate.
  await page.mouse.click(600, 300);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.stage button:focus')).toHaveCount(1);
});

test('more than eight albums: the first key focuses All albums, which opens the full list', async ({ page }) => {
  await mockApi(page, albumList(9));
  await page.goto('/');
  const all = page.getByRole('button', { name: 'All albums (9)' });
  await expect(all).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(all).toBeFocused();
  await expect(page.locator('.album-row')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'All albums', exact: true })).toBeVisible();
  await expect(page.locator('.album-card')).toHaveCount(9);
  await page.keyboard.press('Backspace');
  await expect(all).toBeFocused();
});
