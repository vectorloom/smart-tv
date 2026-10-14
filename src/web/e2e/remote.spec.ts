import { test, expect, type Page } from '@playwright/test';

async function mockGallery(page: Page) {
  await page.route('**/api/albums**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/image')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="green"/></svg>' });
    if (path.endsWith('/photos')) return route.fulfill({ json: { items: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }], nextPage: null } });
    return route.fulfill({ json: [{ id: 'a', name: 'Album A', assetCount: 2 }, { id: 'b', name: 'Album B', assetCount: 2 }] });
  });
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    // Simulate an interrupted transport without reloading the page or copying credentials.
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).includes('/api/remote')) (window as unknown as { remoteSocket: WebSocket }).remoteSocket = this;
      }
    };
  });
}
async function disconnect(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    const ws = (window as unknown as { remoteSocket: WebSocket }).remoteSocket;
    ws.addEventListener('close', () => resolve(), { once: true }); ws.close();
  }));
}

test('two browser contexts pair, route commands to one tab, reconnect both ends and revoke', async ({ browser, page }) => {
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneContext.newPage();
  const other = await page.context().newPage();
  try {
    await mockGallery(page); await mockGallery(other); await mockGallery(phone);
    await page.goto('/'); await other.goto('/');
    await phone.goto('http://127.0.0.1:5173/remote');
    await expect(page.getByRole('button', { name: 'Pair phone', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Pair phone', exact: true }).click();
    const code = await page.locator('.pair-code').innerText();
    await phone.getByLabel('Pairing code from your TV').fill(code);
    await phone.getByRole('button', { name: 'Pair with TV' }).click();
    await expect(phone.getByRole('status')).toHaveText('Connected');
    await expect(page.locator('.pair-code')).toHaveCount(0);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.getByRole('button', { name: /Album A/ }).focus();
    await phone.getByRole('button', { name: 'Right →', exact: true }).click();
    await expect(page.getByRole('button', { name: /Album B/ })).toBeFocused();
    await phone.getByRole('button', { name: '← Left', exact: true }).click();
    await expect(page.getByRole('button', { name: /Album A/ })).toBeFocused();
    await phone.getByRole('button', { name: 'Right →', exact: true }).click();
    await phone.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Album B', exact: true })).toBeVisible();
    await expect(other.getByRole('heading', { name: 'A little of everything. All in one place.', exact: true, }),).toBeVisible();
    await phone.getByRole('button', { name: 'Play / Pause', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await phone.getByRole('button', { name: 'Play / Pause', exact: true }).click();
    await expect(page.locator('.slide-controls button.primary')).toHaveAttribute('aria-label', 'Play slideshow');
    await expect(page.locator('.slide-bottom')).toBeHidden();
    await phone.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('img')).toHaveAttribute('alt', 'Two');
    await phone.getByRole('button', { name: 'Previous', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('img')).toHaveAttribute('alt', 'One');
    await phone.getByRole('button', { name: '↓ Down', exact: true }).click();
    await phone.getByRole('button', { name: '↑ Up', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeFocused();
    await phone.getByRole('button', { name: 'Right →', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('img')).toHaveAttribute('alt', 'Two');
    await phone.getByRole('button', { name: '← Left', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('img')).toHaveAttribute('alt', 'One');
    await phone.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(page.locator('.slide-bottom')).toBeVisible();
    await phone.getByRole('button', { name: '↓ Down', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Play slideshow' })).toBeFocused();
    await phone.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause slideshow' })).toBeFocused();
    await phone.getByRole('button', { name: 'Play / Pause', exact: true }).click();
    await phone.getByRole('button', { name: 'Right →', exact: true }).click();
    await phone.getByRole('button', { name: 'Right →', exact: true }).click();
    await expect(page.getByRole('combobox')).toBeFocused();
    await phone.getByRole('button', { name: '↓ Down', exact: true }).click();
    await expect(page.getByRole('combobox')).toHaveValue('15');
    await phone.getByRole('button', { name: '↑ Up', exact: true }).click();
    await expect(page.getByRole('combobox')).toHaveValue('8');
    await phone.getByRole('button', { name: 'Right →', exact: true }).click();
    await phone.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(page.getByRole('button', { name: /Shuffle/ })).toHaveAttribute('aria-pressed', 'true');
    await phone.getByRole('button', { name: 'Select', exact: true }).click();
    await phone.getByRole('button', { name: 'Right →', exact: true }).click();
    await phone.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(page.locator('.slide-bottom')).toBeHidden();
    await expect(page.getByRole('dialog')).toBeFocused();
    await disconnect(phone);
    await expect(phone.getByRole('status')).toHaveText('Connected');
    await phone.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('img')).toHaveAttribute('alt', 'Two');
    await disconnect(page);
    await expect(page.locator('.pairing')).toContainText('Connected');
    await expect(phone.getByRole('status')).toHaveText('Connected');
    await phone.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await phone.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.getByRole('button', { name: /Album B/ })).toBeFocused();
    await page.getByRole('button', { name: 'Unpair phone' }).click();
    await expect(phone.getByLabel('Pairing code from your TV')).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Pair phone', exact: true }).click();
    await phone.getByLabel('Pairing code from your TV').fill(await page.locator('.pair-code').innerText());
    await phone.getByRole('button', { name: 'Pair with TV' }).click();
    await expect(phone.getByRole('status')).toHaveText('Connected');
    await phone.getByRole('button', { name: 'Unpair phone' }).click();
    await expect(phone.getByLabel('Pairing code from your TV')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unpair phone' })).toHaveCount(0);
  } finally { await phoneContext.close(); await other.close(); }
});

test('live WebSocket rejects unpaired and malformed commands; HTTP rejects foreign origin', async ({ page, request }) => {
  await page.goto('/remote');
  const errors = await page.evaluate(async () => {
    const ws = new WebSocket(`ws://${location.host}/api/remote`);
    const messages: string[] = [];
    return await new Promise<string[]>(resolve => {
      ws.onopen = () => { ws.send(JSON.stringify({ type: 'command', command: 'Next' })); ws.send('{'); };
      ws.onmessage = event => {
        messages.push(JSON.parse(event.data).type);
        if (messages.length === 2) { ws.close(); resolve(messages); }
      };
    });
  });
  expect(errors).toEqual(['error', 'error']);
  const rejected = await request.get('http://127.0.0.1:5080/api/remote', { headers: { Origin: 'http://untrusted.example', Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
  expect(rejected.status()).toBe(403);
});
