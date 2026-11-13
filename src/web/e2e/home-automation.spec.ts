import { test, expect, chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash, createPublicKey } from 'node:crypto';
import { resolve } from 'node:path';

// End to end against the synthetic hosts: the administrator saves a Home Assistant token and devices
// over HTTPS, the TV listener follows a fake Home Assistant WebSocket, and the D-pad toggles lights.
const origin = 'https://localhost:5443';
const publicOrigin = 'http://127.0.0.1:5082';
const fakeHomeAssistant = 'http://127.0.0.1:5092';
const token = 'synthetic-ha-token';

test('administrator connects Home Assistant; the TV toggles with the D-pad and follows changes live', async ({ page, request }) => {
  test.setTimeout(90000);
  const cert = readFileSync(resolve('../../.local/settings-browser/material/localhost.crt'));
  const pin = createHash('sha256').update(createPublicKey(cert).export({ type: 'spki', format: 'der' })).digest('base64');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const adminBrowser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: [`--ignore-certificate-errors-spki-list=${pin}`] });
  const context = await adminBrowser.newContext(); const admin = await context.newPage();
  const haStatus = admin.getByRole('status', { name: 'Home Assistant status' });
  try {
    // Before configuration the TV explains what to do.
    await page.goto(`${publicOrigin}/home-automation`);
    await expect(page.getByRole('heading', { name: 'Home Assistant isn’t connected yet' })).toBeVisible();

    await admin.goto(`${origin}/settings`);
    await admin.getByLabel('Administrator passphrase').fill('synthetic-browser-passphrase');
    await admin.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(admin.getByLabel('Approved Home Assistant connection')).toHaveValue('http://127.0.0.1:5092/api/');
    await expect(admin.getByLabel('New or replacement access token')).toHaveAttribute('type', 'password');
    await admin.getByLabel('New or replacement access token').fill(token);
    await admin.getByRole('button', { name: 'Validate and save Home Assistant' }).click();
    await expect(haStatus).toContainText('Home Assistant settings saved');
    await expect(admin.getByLabel('Saved access token identifier')).toHaveText('synt' + '•'.repeat(10) + 'oken');
    for (const name of [/^Kitchen/, /^Living room/, /^Ceiling fan/, /^Hallway thermostat/]) await admin.getByLabel(name).check();
    await expect(admin.getByLabel(/^Outdoor temperature/)).toHaveCount(0); // sensors are not offered
    await admin.getByRole('button', { name: 'Validate and save Home Assistant' }).click();
    await expect(haStatus).toContainText('Home Assistant settings saved');
    const adminView = await admin.evaluate(async () => (await fetch('/api/admin/home-assistant')).text());
    expect(adminView).not.toContain('synthetic-ha-token');

    // The open TV page picks the save up by itself: no reload.
    await page.evaluate(() => { (window as unknown as { marker: boolean }).marker = true; });
    const kitchen = page.getByRole('button', { name: /^Kitchen/ });
    await expect(kitchen).toHaveAttribute('aria-pressed', 'true', { timeout: 15000 });
    await expect(kitchen).toHaveText('KitchenOn · 60%');
    await expect(page.getByRole('status')).toHaveText('Live from Home Assistant');
    await expect(page.getByRole('region', { name: 'Climate' })).toContainText('69°');

    // D-pad: focus starts on the first light; Right, Down and OK toggle the fan.
    await page.reload();
    await expect(kitchen).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('button', { name: /^Living room/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const fan = page.getByRole('button', { name: /^Ceiling fan/ });
    await expect(fan).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(fan).toHaveAttribute('aria-pressed', 'true');
    await expect(fan).toHaveText('Ceiling fanOn');
    await page.keyboard.press('Enter');
    await expect(fan).toHaveAttribute('aria-pressed', 'false');
    // The read-only thermostat is reachable (so the remote can scroll to it) and OK does nothing there.
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('listitem', { name: 'Hallway thermostat' })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowUp');
    await expect(fan).toBeFocused();
    await expect(fan).toHaveAttribute('aria-pressed', 'false');

    // A wall switch changes the kitchen light: the screen follows without a reload.
    await page.evaluate(() => { (window as unknown as { marker: boolean }).marker = true; });
    expect((await request.post(`${fakeHomeAssistant}/test/state/light.kitchen/off`)).status()).toBe(204);
    await expect(kitchen).toHaveText('KitchenOff');
    expect(await page.evaluate(() => (window as unknown as { marker?: boolean }).marker)).toBe(true);

    // The token never reaches the TV, and a foreign page cannot send a toggle.
    const published = await (await request.get(`${publicOrigin}/api/home`)).text();
    expect(published).not.toContain(token);
    expect(published).toContain('light.kitchen');
    const simple = await page.evaluate(async () => (await fetch('/api/home/entities/light.kitchen/toggle', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status);
    expect(simple).toBe(415);
    const rebinding = await request.post(`${publicOrigin}/api/home/entities/light.kitchen/toggle`, { data: {}, headers: { Host: 'tv.attacker.example:5082' } });
    expect(rebinding.status()).toBe(403);
    await expect(kitchen).toHaveText('KitchenOff');
  } finally { await context.close(); await adminBrowser.close(); }
});
