import { test, expect, type Page } from '@playwright/test';

// Stage 2: routes, navigation rail, focus zones, Back/popstate, Photos rows and the full-screen viewer.

const albums = [
  { id: 'lake', name: 'Summer at the lake', assetCount: 14, thumbnailId: null },
  { id: 'city', name: 'City weekends', assetCount: 3, thumbnailId: null },
  { id: 'snow', name: 'Snow days', assetCount: 2, thumbnailId: null },
];
const photosOf = (id: string) => Array.from({ length: albums.find(a => a.id === id)!.assetCount }, (_, i) => ({ id: `${id}-${i + 1}`, name: `${id} ${i + 1}` }));
const colours = ['#6b5a48', '#3f4a3c', '#46505e', '#5e4a46', '#4a5e58'];

const hourly = Array.from({ length: 12 }, (_, i) => ({
  time: `2026-11-12T${String(12 + i).padStart(2, '0')}:00`, temperatureF: 71 - i, weatherCode: 0, condition: 'Clear', precipitationProbability: i * 4,
}));
const daily = Array.from({ length: 7 }, (_, i) => ({
  date: `2026-11-${12 + i}`, highF: 74 - i, lowF: 51 - i, weatherCode: [0, 2, 61, 3, 95, 0, 1][i], condition: ['Clear sky', 'Partly cloudy', 'Light rain', 'Overcast', 'Thunderstorm', 'Clear sky', 'Mainly clear'][i], precipitationProbability: [0, 10, 70, 20, 40, 0, 5][i],
}));

// Enough devices to fill the screen: long names must ellipsize, and nothing may fall under 16px.
const homeSnapshot = { status: 'live', message: null, entities: [
  ...['Kitchen', 'Living room', 'Dining table pendant', 'Hallway', 'Primary bedroom ceiling and reading lamps', 'Porch'].map((name, i) => ({
    id: `light.l${i}`, domain: 'light', name, state: i === 5 ? 'unavailable' : i % 2 ? 'off' : 'on', available: i !== 5, on: i % 2 === 0 && i !== 5,
    toggleable: true, brightness: i % 2 === 0 ? 40 + i * 10 : null })),
  { id: 'switch.fan', domain: 'switch', name: 'Ceiling fan', state: 'on', available: true, on: true, toggleable: true },
  { id: 'climate.hall', domain: 'climate', name: 'Hallway thermostat', state: 'heat_cool', available: true, on: true, toggleable: false,
    currentTemperature: 68.5, targetLow: 66, targetHigh: 72, hvacAction: 'idle', unit: '°F' },
] };

async function mockApi(page: Page, list = albums) {
  // A local stand-in for the remote-control socket: these tests load many pages quickly and would
  // otherwise hit the server's per-address connection limit. The pairing flow itself is in remote.spec.
  await page.routeWebSocket(/\/api\/remote$/, ws => ws.onMessage(raw => {
    const message = JSON.parse(String(raw));
    if (message.type === 'register') ws.send(JSON.stringify({ type: 'ready', credential: 'c'.repeat(64), connected: false }));
    if (message.type === 'code') ws.send(JSON.stringify({ type: 'code', code: '12345678', expires: new Date(Date.now() + 120_000).toISOString() }));
  }));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/image')) {
      const n = Number(/-(\d+)\/image$/.exec(path)?.[1] ?? 0);
      return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="960"><rect width="1440" height="960" fill="${colours[n % colours.length]}"/><circle cx="1000" cy="300" r="120" fill="#e8c38a"/></svg>` });
    }
    if (path === '/api/albums') return route.fulfill({ json: list });
    const photos = /^\/api\/albums\/([^/]+)\/photos$/.exec(path);
    if (photos) {
      const count = list.find(a => a.id === photos[1])?.assetCount ?? 0;
      return route.fulfill({ json: { items: Array.from({ length: count }, (_, i) => ({ id: `${photos[1]}-${i + 1}`, name: `${photos[1]} ${i + 1}` })), nextPage: null } });
    }
    if (path === '/api/home/events') return route.fulfill({ status: 200, contentType: 'text/event-stream',
      body: `retry: 600000\nevent: snapshot\ndata: ${JSON.stringify(homeSnapshot)}\n\n` });
    if (path === '/api/slideshow/next') return route.fulfill({ json: { albumId: 'lake', albumName: 'Summer at the lake', photoId: 'lake-1', takenAt: '2024-07-04T18:30:00.000Z', index: 1, total: 14 } });
    if (path === '/api/weather') return route.fulfill({ json: {
      location: 'Coppell', lastUpdated: '2026-11-12T18:14:00Z', stale: false,
      current: { time: '2026-11-12T12:00', temperatureF: 71.4, weatherCode: 0, condition: 'Clear sky', isDay: true,
        precipitationProbability: 0, relativeHumidity: 41, windSpeedMph: 12.2, windDirectionDegrees: 180, pressureHpa: 1012 },
      hourly, daily,
    } });
    if (path === '/api/weather/wind') return route.fulfill({ json: {
      location: 'Coppell', lastUpdated: '2026-11-12T18:14:00Z', stale: false, validTime: '2026-11-12T12:00',
      points: Array.from({ length: 25 }, (_, i) => ({ latitude: 32.8 + Math.floor(i / 5) * .15, longitude: -97.3 + (i % 5) * .15, windSpeedMph: 5 + i, windDirectionDegrees: 180 })),
    } });
    return route.fulfill({ status: 404, json: { message: 'not found' } });
  });
}

const focused = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.focusKey ?? document.activeElement?.className ?? null);

test('rail is hidden on idle home, slides in on the first key, and hides again after 30 s', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-12T12:58:00') });
  await mockApi(page);
  await page.goto('/');
  await page.clock.runFor(500);
  const rail = page.getByRole('navigation', { name: 'Main' });
  await expect(rail).toBeHidden();
  await page.keyboard.press('ArrowDown');
  await expect(rail).toBeVisible();
  await expect(page.getByRole('button', { name: 'Summer at the lake' })).toBeFocused();
  // Rail labels are showing (expanded) on home.
  await expect(rail.getByText('Photos')).toBeVisible();
  // Left from the leftmost album button enters the rail on the current section.
  await page.keyboard.press('ArrowLeft');
  await expect(rail.getByRole('button', { name: 'Home', exact: true })).toBeFocused();
  await expect(rail.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Summer at the lake' })).toBeFocused();
  await page.clock.runFor(30_500);
  await expect(rail).toBeHidden();
  await expect(page.locator('.album-row')).toHaveCount(0);
  await expect(page.locator('.stage button:focus')).toHaveCount(0);
});

test('choosing a rail item closes the home flyout, from home or from another screen', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'All albums (3)' })).toBeVisible();
  const rail = page.getByRole('navigation', { name: 'Main' });
  await page.keyboard.press('ArrowDown');
  await expect(rail).toBeVisible();
  // Clicking Home while on home closes the flyout; focus stays on the screen.
  await rail.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(rail).toBeHidden();
  await expect(page.locator('.stage button:focus')).toHaveCount(1);
  // Left from the leftmost album button opens it again.
  await page.getByRole('button', { name: 'Summer at the lake' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(rail.getByRole('button', { name: 'Home', exact: true })).toBeFocused();
  // Coming home from another screen through the rail leaves it closed too.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/photos$/);
  await page.keyboard.press('ArrowLeft');
  await rail.getByRole('button', { name: 'Home', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/$/);
  await expect(rail).toBeHidden();
});

test('mouse on home: the photo shows albums but not the menu; the left edge opens it and leaving closes it', async ({ page }) => {
  await page.setViewportSize({ width: 1892, height: 1013 });
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'All albums (3)' })).toBeVisible();
  const rail = page.getByRole('navigation', { name: 'Main' });
  await page.mouse.move(900, 500);
  await page.mouse.move(950, 520, { steps: 4 });
  await expect(page.locator('.album-row')).toBeVisible();
  await expect(rail).toBeHidden();
  // The left edge of the stage (pillarboxed here) opens the menu; it stays open while the pointer is on it.
  await page.mouse.move(80, 500, { steps: 6 });
  await expect(rail).toBeVisible();
  await page.mouse.move(300, 420, { steps: 4 });
  await page.waitForTimeout(2000);
  await expect(rail).toBeVisible();
  // Moving away closes it after a short delay, while the album row stays for the 30 s idle period.
  await page.mouse.move(900, 500, { steps: 6 });
  await expect(rail).toBeHidden({ timeout: 4000 });
  await expect(page.locator('.album-row')).toBeVisible();
  // Leaving the window closes it too.
  await page.mouse.move(60, 500, { steps: 4 });
  await expect(rail).toBeVisible();
  await page.mouse.move(-5, 500);
  await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
  await expect(rail).toBeHidden({ timeout: 4000 });
});

test('rail navigates between screens, stays collapsed at 112 px and expands while focused', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'All albums (3)' })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowLeft');
  const rail = page.getByRole('navigation', { name: 'Main' });
  await expect(rail.getByRole('button', { name: 'Home', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rail.getByRole('button', { name: 'Photos' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/photos$/);
  // Focus moves into the content once the rows have loaded: the first photo of the first row.
  await expect.poll(() => focused(page)).toBe('photo:lake:lake-1');
  await expect.poll(async () => (await rail.boundingBox())!.width).toBeCloseTo(112, 0);
  await expect(rail.getByRole('button', { name: 'Photos' })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('ArrowLeft');
  await expect(rail.getByRole('button', { name: 'Photos' })).toBeFocused();
  await expect.poll(async () => (await rail.boundingBox())!.width).toBeCloseTo(340, 0);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => focused(page)).toBe('photo:lake:lake-1');
  for (const [name, url, heading] of [['Weather', /\/weather$/, 'Weather'], ['Home automation', /\/home-automation$/, 'Home automation'],
    ['Calendar', /\/calendar$/, 'Calendar'], ['Settings', /\/preferences$/, 'Settings']] as const) {
    await page.keyboard.press('ArrowLeft');
    await rail.getByRole('button', { name }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(url);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  }
  // Back walks the history: Settings → Calendar → … → Photos, with focus restored on Photos.
  for (const url of [/\/calendar$/, /\/home-automation$/, /\/weather$/, /\/photos$/]) {
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(url);
  }
  await expect.poll(() => focused(page)).toBe('photo:lake:lake-1');
  await page.keyboard.press('Backspace');
  await expect(page).toHaveURL(/\/$/);
});

test('Photos rows: a photo opens the full-screen viewer; Escape and browser Back restore focus to it', async ({ page }) => {
  await mockApi(page);
  await page.goto('/photos');
  await expect.poll(() => focused(page)).toBe('photo:lake:lake-1');
  await expect(page.locator('.photo-row')).toHaveCount(3);
  // Rows show up to 12 photos then a See all tile.
  await expect(page.locator('.photo-row').first().locator('.thumb:not(.see-all)')).toHaveCount(12);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => focused(page)).toBe('photo:lake:lake-2');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focused(page)).toMatch(/^photo:city:/);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => focused(page)).toBe('photo:lake:lake-3');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/photos\/lake\?photo=lake-3$/);
  await expect(dialog.getByRole('img')).toHaveAttribute('alt', 'lake 3');
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('img')).toHaveAttribute('alt', 'lake 4');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/photos$/);
  await expect.poll(() => focused(page)).toBe('photo:lake:lake-3');
  // The browser's own Back (popstate, as from a TV remote's back button) behaves the same.
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe('photo:lake:lake-3');
  // Forward reopens the viewer from history.
  await page.goForward();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Backspace');
  await expect(dialog).toHaveCount(0);
});

test('See all opens the album; Play album and PlayPause start the viewer; deep links go Back one level', async ({ page }) => {
  await mockApi(page);
  await page.goto('/photos');
  await expect.poll(() => focused(page)).toBe('photo:lake:lake-1');
  await page.locator('[data-focus-key="album:lake:all"]').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/photos\/lake$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Summer at the lake' })).toBeVisible();
  await expect(page.locator('.thumb-grid .thumb')).toHaveCount(14);
  const play = page.getByRole('button', { name: 'Play album' });
  await expect(play).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByRole('img')).toHaveAttribute('alt', 'lake 1');
  await page.keyboard.press('Escape');
  await expect(play).toBeFocused();
  // Photo 14 is the last tile; Back from its viewer returns to it.
  await page.locator('[data-focus-key="photo:lake:lake-14"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByRole('img')).toHaveAttribute('alt', 'lake 14');
  await page.keyboard.press('Escape');
  await expect.poll(() => focused(page)).toBe('photo:lake:lake-14');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/photos$/);
  await expect.poll(() => focused(page)).toBe('album:lake:all');
  // A deep link has no history: Back goes up a level instead of leaving the app.
  await page.goto('/photos/city');
  await expect(page.getByRole('button', { name: 'Play album' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/photos$/);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/$/);
});

test('home album buttons open the album; Home returns to that album button', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'All albums (3)' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'City weekends' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/photos\/city$/);
  await page.keyboard.press('Home');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: 'City weekends' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'All albums (3)' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/photos$/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'All albums (3)' })).toBeFocused();
});

test('mouse clicks work like Enter: rail items, photos and the viewer', async ({ page }) => {
  await page.setViewportSize({ width: 1892, height: 1013 });
  await mockApi(page);
  await page.goto('/weather');
  const rail = page.getByRole('navigation', { name: 'Main' });
  await rail.getByRole('button', { name: 'Photos' }).click();
  await expect(page).toHaveURL(/\/photos$/);
  await page.locator('[data-focus-key="photo:snow:snow-2"]').click();
  await expect(page.getByRole('dialog').getByRole('img')).toHaveAttribute('alt', 'snow 2');
  await page.keyboard.press('Escape');
  await expect.poll(() => focused(page)).toBe('photo:snow:snow-2');
  await page.mouse.click(4, 500); // letterbox bar: focus falls to the page, keys still work
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.stage button:focus')).toHaveCount(1);
});

test('Settings shows pairing and display details', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await mockApi(page);
  await page.goto('/preferences');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pair phone' })).toBeEnabled();
  await expect(page.getByText('1280 × 720')).toBeVisible();
  await expect(page.getByText('1920 × 1080 at 67%')).toBeVisible();
  await page.getByRole('button', { name: 'Pair phone' }).click();
  await expect(page.locator('.pair-code')).toHaveText('12345678');
});

test('Photos caps rows at 20 and loads thumbnails only near the focused row', async ({ page }) => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `al${i}`, name: `Album ${i + 1}`, assetCount: 4, thumbnailId: null }));
  const listed: string[] = [];
  page.on('request', request => {
    const id = /\/api\/albums\/([^/]+)\/photos\?/.exec(request.url())?.[1];
    if (id) listed.push(id);
  });
  await mockApi(page, many);
  await page.goto('/photos');
  await expect.poll(() => focused(page)).toBe('photo:al0:al0-1');
  await expect(page.locator('.photo-row')).toHaveCount(20);
  // Albums 21–25 stay reachable as plain buttons.
  await expect(page.getByRole('region', { name: 'More albums' }).getByRole('button')).toHaveCount(5);
  const imagesIn = (row: number) => page.locator(`.photo-row[data-row="${row}"] .thumb img`).count();
  // Only the focused row and the two after it have fetched photo lists and show images.
  expect([...new Set(listed)].sort()).toEqual(['al0', 'al1', 'al2']);
  expect(await imagesIn(0)).toBe(4);
  expect(await imagesIn(2)).toBe(4);
  expect(await imagesIn(3)).toBe(0);
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await expect.poll(() => focused(page)).toMatch(/^photo:al5:/);
  await expect.poll(() => imagesIn(7)).toBe(4);
  // Rows that fell behind release their images but keep their buttons, so Back can return to them.
  expect(await imagesIn(0)).toBe(0);
  expect(await page.locator('[data-focus-key="photo:al0:al0-1"]').count()).toBe(1);
  expect(listed).not.toContain('al10');
  // The More albums buttons open their album.
  await page.getByRole('region', { name: 'More albums' }).getByRole('button', { name: /Album 25/ }).click();
  await expect(page).toHaveURL(/\/photos\/al24$/);
});

const screens = [['home', '/'], ['photos', '/photos'], ['album', '/photos/lake'], ['viewer', '/photos/lake?photo=lake-2'],
  ['weather', '/weather'], ['automation', '/home-automation'], ['calendar', '/calendar'], ['settings', '/preferences']] as const;
for (const [width, height] of [[1920, 1080], [960, 540]] as const) {
  test(`every screen fits ${width}×${height}: stage visible, page never scrolls, text ≥16px at 1080p scale`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.clock.setFixedTime(new Date('2026-11-12T12:58:00'));
    await mockApi(page);
    for (const [name, path] of screens) {
      await page.goto(path);
      if (name === 'viewer') {
        // The full-screen viewer with its controls showing.
        await expect(page.getByRole('dialog')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.locator('.slide-bottom')).toBeVisible();
      } else await expect(page.locator('.stage h1, .stage .clock').first()).toBeVisible();
      if (name === 'photos') await expect(page.locator('.photo-row .thumb img').first()).toBeVisible();
      if (name === 'weather') await expect(page.locator('.week li')).toHaveCount(7);
      if (name === 'automation') await expect(page.locator('.device-tile')).toHaveCount(7);
      if (width === 1920) await page.screenshot({ path: `test-results/screen-${name}.png`, animations: 'disabled' });
      // Open the rail (on home with the first key, elsewhere by focusing it) so its labels are checked too.
      if (name === 'home') await page.keyboard.press('ArrowDown');
      else if (name !== 'viewer') await page.getByRole('navigation', { name: 'Main' }).getByRole('button').first().focus();
      if (width === 1920 && (name === 'home' || name === 'photos'))
        await page.screenshot({ path: `test-results/screen-${name}-rail.png`, animations: 'disabled' });
      const result = await page.evaluate(() => {
        const stage = document.querySelector('.stage')!.getBoundingClientRect();
        const scale = stage.width / 1920;
        const small: string[] = [];
        for (const element of document.querySelectorAll<HTMLElement>('.stage *')) {
          const ownText = [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent!.trim());
          const box = element.getBoundingClientRect();
          if (!ownText || box.width === 0 || getComputedStyle(element).visibility === 'hidden') continue;
          const size = parseFloat(getComputedStyle(element).fontSize);
          if (size < 16) small.push(`${element.tagName}.${element.getAttribute('class')} ${size}px "${element.textContent!.trim().slice(0, 24)}"`);
        }
        return {
          inside: stage.left >= -0.5 && stage.top >= -0.5 && stage.right <= innerWidth + 0.5 && stage.bottom <= innerHeight + 0.5,
          scale, page: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
          small,
        };
      });
      expect(result.inside, name).toBe(true);
      expect(result.scale).toBeCloseTo(width / 1920, 3);
      expect(result.page.w, name).toBeLessThanOrEqual(width);
      expect(result.page.h, name).toBeLessThanOrEqual(height);
      expect(result.small, name).toEqual([]);
    }
  });
}
