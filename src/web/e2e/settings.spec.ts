import { test, expect, chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash, createPublicKey } from 'node:crypto';
import { resolve } from 'node:path';

test('HTTPS administrator settings, migration, selection, replacement rollback, and listener isolation', async ({ page, request }) => {
  test.setTimeout(90000);
  // Test-only trust pin for the newly generated fixture certificate. This does not
  // alter a host/browser trust store and does not disable validation for other keys.
  const cert = readFileSync(resolve('../../.local/settings-browser/material/localhost.crt'));
  const pin = createHash('sha256').update(createPublicKey(cert).export({ type: 'spki', format: 'der' })).digest('base64');
  const adminBrowser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: [`--ignore-certificate-errors-spki-list=${pin}`] });
  const context = await adminBrowser.newContext(); const admin = await context.newPage();
  const origin = 'https://localhost:5443';
  const publicOrigin = 'http://127.0.0.1:5082';
  try {
    await admin.goto(`${origin}/settings`);
    await expect(admin.getByLabel('Administrator passphrase')).toBeVisible();
    const unauthorized = await admin.evaluate(async () => Promise.all(['/api/admin/settings', '/api/admin/albums', '/api/admin/albums/11111111-1111-4111-8111-111111111111/thumbnail'].map(async path => (await fetch(path)).status)));
    expect(unauthorized).toEqual([401, 401, 401]);
    expect((await request.get(`${publicOrigin}/settings`)).status()).toBe(404);
    expect((await request.get(`${publicOrigin}/api/admin/settings`, { headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Port': '8443' } })).status()).toBe(404);
    await admin.getByLabel('Administrator passphrase').fill('synthetic-wrong-passphrase');
    await admin.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(admin.getByRole('status', { name: '', exact: true })).toContainText('Sign-in failed');
    await admin.getByLabel('Administrator passphrase').fill('synthetic-browser-passphrase');
    await admin.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(admin.getByText('Configuration source:')).toContainText('environment');
    await expect(admin.getByLabel('Saved API key identifier')).toHaveText('synt' + '•'.repeat(13) + '-key');
    await expect(admin.getByLabel('Shared holiday', { exact: false })).toBeVisible();
    await expect(admin.getByLabel('New or replacement API key')).toHaveAttribute('type', 'password');
    await expect(admin.getByLabel('New or replacement API key')).toHaveAttribute('autocomplete', 'off');
    const safe = await admin.evaluate(async () => {
      const response = await fetch('/api/admin/settings');
      const text = await response.text(); const body = JSON.parse(text);
      return { configured: body.settings.keyConfigured, safe: !text.includes('synthetic-browser-key') && !text.includes('protectedKey') && !text.includes('passwordHash') };
    });
    expect(safe).toEqual({ configured: true, safe: true });
    // Cookie possession never bypasses the public listener's settings gate.
    const cookie = (await context.cookies()).find(item => item.name === '__Host-smart-tv-admin')!;
    expect((await request.get(`${publicOrigin}/api/admin/settings`, { headers: { Cookie: `${cookie.name}=${cookie.value}` } })).status()).toBe(404);
    const csrfRejected = await admin.evaluate(async () => (await fetch('/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
    expect(csrfRejected).toBe(400);
    await admin.getByRole('button', { name: 'Validate and import environment configuration' }).click();
    await expect(admin.getByRole('status', { name: '', exact: true })).toContainText('Settings saved');
    await expect(admin.getByText('Configuration source:')).toContainText('persisted');
    await admin.getByLabel('Shared holiday', { exact: false }).check();
    await admin.getByRole('button', { name: 'Validate and save', exact: true }).click();
    await expect(admin.getByRole('status', { name: '', exact: true })).toContainText('Settings saved');
    await page.goto(publicOrigin);
    await expect(page.getByRole('button', { name: /Shared holiday/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /My album/ })).toBeVisible();
    await admin.getByLabel('New or replacement API key').fill('synthetic-invalid-key');
    await admin.getByRole('button', { name: 'Validate and save', exact: true }).click();
    await expect(admin.getByRole('status', { name: '', exact: true })).toContainText('Immich denied access');
    await expect(admin.getByLabel('Saved API key identifier')).toHaveText('synt' + '•'.repeat(13) + '-key');
    await expect(admin.getByLabel('New or replacement API key')).toHaveValue('');
    await page.reload(); await expect(page.getByRole('button', { name: /Shared holiday/ })).toBeVisible();
    await admin.getByLabel('New or replacement API key').fill('synthetic-browser-replacement');
    await admin.getByRole('button', { name: 'Validate and save', exact: true }).click();
    await expect(admin.getByRole('status', { name: '', exact: true })).toContainText('Settings saved');
    await expect(admin.getByLabel('Saved API key identifier')).toHaveText('synt' + '•'.repeat(21) + 'ment');
    await admin.reload(); await expect(admin.getByLabel('Shared holiday', { exact: false })).toBeChecked();
    await expect(admin.getByLabel('New or replacement API key')).toHaveValue('');
    await admin.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(admin.getByLabel('Administrator passphrase')).toBeVisible();
    // Replay a previously valid cookie after server-side logout revocation.
    await context.addCookies([{ name: cookie.name, value: cookie.value, url: origin, secure: true, httpOnly: true, sameSite: 'Strict' }]);
    expect(await admin.evaluate(async () => (await fetch('/api/admin/settings')).status)).toBe(401);
    // A phone pairing-shaped credential is not an administrator session.
    await context.addCookies([{ name: cookie.name, value: 'synthetic-phone-credential', url: origin, secure: true, httpOnly: true, sameSite: 'Strict' }]);
    expect(await admin.evaluate(async () => (await fetch('/api/admin/settings')).status)).toBe(401);
  } finally { await context.close(); await adminBrowser.close(); }
});
