import { test, expect } from '@playwright/test';

test('weather metrics and wind grid render at 1080p without overflow or focus stops', async ({ page }) => {
  await page.addInitScript(() => {
    const segments: Array<[number, number, number, number]> = [];
    const frameTimes: number[] = [];
    (window as unknown as { __windObservedSegments: typeof segments; __windFrameTimes: typeof frameTimes }).__windObservedSegments = segments;
    (window as unknown as { __windFrameTimes: typeof frameTimes }).__windFrameTimes = frameTimes;
    const requestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => requestAnimationFrame(time => {
      if (frameTimes[frameTimes.length - 1] !== time) frameTimes.push(time);
      callback(time);
    });
    const originalMoveTo = CanvasRenderingContext2D.prototype.moveTo;
    const originalBezierCurveTo = CanvasRenderingContext2D.prototype.bezierCurveTo;
    CanvasRenderingContext2D.prototype.moveTo = function (x, y) {
      if (this.canvas.classList.contains('weather-wind-canvas'))
        (this as CanvasRenderingContext2D & { windStart?: [number, number] }).windStart = [x, y];
      return originalMoveTo.call(this, x, y);
    };
    CanvasRenderingContext2D.prototype.bezierCurveTo = function (cx1, cy1, cx2, cy2, x, y) {
      if (this.canvas.classList.contains('weather-wind-canvas')) {
        const context = this as CanvasRenderingContext2D & { windStart?: [number, number] };
        if (context.windStart) segments.push([context.windStart[0], context.windStart[1], x, y]);
        context.windStart = [x, y];
      }
      return originalBezierCurveTo.call(this, cx1, cy1, cx2, cy2, x, y);
    };
  });
  const hourly = Array.from({ length: 12 }, (_, i) => ({
    time: `2026-09-26T${String(9 + i).padStart(2, '0')}:00`, temperatureF: 81 + i,
    weatherCode: 2, condition: 'Partly cloudy', precipitationProbability: i * 5,
  }));
  const daily = Array.from({ length: 7 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 8, 26 + i)).toISOString().slice(0, 10), highF: 87 - i,
    lowF: 70 - i, weatherCode: 2, condition: 'Partly cloudy', precipitationProbability: 10 + i * 5,
  }));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/weather') return route.fulfill({ json: {
      location: 'Coppell', lastUpdated: '2026-09-26T14:00:00Z', stale: false,
      current: { time: '2026-09-26T09:00', temperatureF: 81.4, weatherCode: 2, condition: 'Partly cloudy', isDay: true,
        precipitationProbability: 10, relativeHumidity: 58, windSpeedMph: 9.2, windDirectionDegrees: 0, pressureHpa: 1008.4 },
      hourly, daily,
    } });
    if (path === '/api/weather/wind') return route.fulfill({ json: {
      location: 'Coppell', lastUpdated: '2026-09-26T14:00:00Z', stale: false, validTime: '2026-09-26T09:00',
      points: Array.from({ length: 25 }, (_, i) => ({ latitude: 32.65 + Math.floor(i / 5) * .15,
        longitude: -97.17 + (i % 5) * .15, windSpeedMph: 5 + i, windDirectionDegrees: 0 })),
    } });
    if (path === '/api/albums') return route.fulfill({ json: [{ id: 'album-a', name: 'Family Photos', assetCount: 2 }] });
    return route.fulfill({ json: { items: [], nextPage: null } });
  });

  await page.goto('/');
  await expect(page.getByText('9 mph N', { exact: true })).toBeVisible();
  await expect(page.getByText('58%')).toBeVisible();
  const map = page.locator('.weather-wind-map');
  await expect(map).toBeVisible();
  await expect(map).toContainText('Coppell');
  await expect(map).toContainText('GRID 2026-09-26T09:00');
  await expect(map).toContainText('FLOW S');
  await expect(map).toHaveAttribute('data-grid-points', '25');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1920);
  expect(await map.locator('button, a, input, select, [tabindex]').count()).toBe(0);
  await page.keyboard.press('Tab');
  await expect(map).not.toBeFocused();
  await page.waitForTimeout(2500);
  const observed = await page.evaluate(() => {
    const segments = (window as unknown as { __windObservedSegments: Array<[number, number, number, number]> }).__windObservedSegments;
    const frames = (window as unknown as { __windFrameTimes: number[] }).__windFrameTimes;
    const steps = segments.map(([, y0, , y1]) => y1 - y0).filter(step => step > 0);
    const elapsed = frames.length > 1 ? (frames[frames.length - 1] - frames[0]) / 1000 : 0;
    return { count: segments.length, southFraction: steps.length / segments.length,
      speedRatio: Math.max(...steps) / Math.min(...steps), frameRate: elapsed ? (frames.length - 1) / elapsed : 0 };
  });
  expect(observed.count).toBeGreaterThan(1000);
  expect(observed.southFraction).toBeGreaterThan(.99);
  expect(observed.speedRatio).toBeGreaterThan(1.5);
  expect(observed.frameRate).toBeGreaterThan(25);
});
