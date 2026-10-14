import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Settings } from './Settings';

it('keeps replacement keys write-only, lists shared albums, and retains form selection on failed save', async () => {
  let authenticated = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/csrf')) return new Response(JSON.stringify({ token: 'synthetic-csrf' }));
    if (url.endsWith('/session')) return new Response('{}', { status: authenticated ? 200 : 401 });
    if (url.endsWith('/login')) { authenticated = true; return new Response('{}'); }
    if (url.endsWith('/settings') && options?.method === 'PUT') return new Response(JSON.stringify({ message: 'Validation failed; previous settings retained.' }), { status: 400 });
    if (url.endsWith('/settings')) return new Response(JSON.stringify({ settings: { revision: 'one', source: 'persisted', baseUrl: 'http://immich.test/api/', keyConfigured: true, maskedKey: "abcd••••wxyz", albumIds: ['shared'] }, targets: ['http://immich.test/api/'] }));
    if (url.endsWith('/albums')) return new Response(JSON.stringify([{ id: 'shared', name: 'Shared memories', assetCount: 1, thumbnailId: null }]));
    return new Response('{}');
  }));
  try {
    render(<Settings />);
    const password = await screen.findByLabelText('Administrator passphrase');
    fireEvent.change(password, { target: { value: 'synthetic-passphrase' } }); fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const key = await screen.findByLabelText('New or replacement API key');
    expect(key).toHaveAttribute('type', 'password'); expect(key).toHaveAttribute('autocomplete', 'off'); expect(key).toHaveValue('');
    expect(screen.getByLabelText('Saved API key identifier')).toHaveTextContent('abcd••••wxyz');
    await waitFor(() => expect(screen.getByLabelText(/Shared memories/)).toBeChecked());
    fireEvent.change(key, { target: { value: 'synthetic-invalid-key' } }); fireEvent.click(screen.getByRole('button', { name: 'Validate and save' }));
    await screen.findByText('Validation failed; previous settings retained.');
    expect(screen.getByLabelText('Saved API key identifier')).toHaveTextContent('abcd••••wxyz');
    expect(key).toHaveValue(''); expect(screen.getByLabelText(/Shared memories/)).toBeChecked();
  } finally { vi.unstubAllGlobals(); }
});

it('updates the read-only identifier from the save response even if reloading fails', async () => {
  let saved = false;
  const configuration = { revision: 'one', source: 'persisted', baseUrl: 'http://immich.test/api/', keyConfigured: true, maskedKey: 'abcd••••wxyz', albumIds: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/csrf')) return new Response(JSON.stringify({ token: 'synthetic-csrf' }));
    if (url.endsWith('/settings') && options?.method === 'PUT') {
      saved = true;
      return new Response(JSON.stringify({ ...configuration, revision: 'two', maskedKey: 'efgh••••ijkl' }));
    }
    if (url.endsWith('/settings')) return saved
      ? new Response('{}', { status: 503 })
      : new Response(JSON.stringify({ settings: configuration, targets: [configuration.baseUrl] }));
    if (url.endsWith('/albums')) return new Response('[]');
    return new Response('{}');
  }));
  try {
    render(<Settings />);
    const key = await screen.findByLabelText('New or replacement API key');
    expect(key).toHaveValue('');
    fireEvent.change(key, { target: { value: 'synthetic-replacement' } });
    fireEvent.click(screen.getByRole('button', { name: 'Validate and save' }));
    await waitFor(() => expect(screen.getByLabelText('Saved API key identifier')).toHaveTextContent('efgh••••ijkl'));
    expect(screen.getByLabelText('Saved API key identifier').tagName).toBe('OUTPUT');
    expect(key).toHaveValue('');
  } finally { vi.unstubAllGlobals(); }
});
