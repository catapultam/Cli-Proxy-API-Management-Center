import { describe, expect, test, spyOn } from 'bun:test';
import axios from 'axios';
import { apiClient } from '@/services/api/client';
import { sessionApi } from '@/services/api/session';

/**
 * The backend's CORS policy is ACAO `*` without Allow-Credentials (see the management login
 * design spec's "Other contract details"). A credentialed (`withCredentials: true`) cross-origin
 * request fails outright in the browser under that policy, breaking both cross-origin key mode
 * and cross-origin bearer-session mode. Same-origin requests send the session cookie regardless
 * of `withCredentials`, so there is no upside to setting it.
 */
describe('cross-origin credential safety', () => {
  test('apiClient does not enable withCredentials by default', () => {
    const instance = (apiClient as unknown as { instance: { defaults: Record<string, unknown> } })
      .instance;
    expect(instance.defaults.withCredentials).toBeFalsy();
  });

  test('session requests (status/login/passkey/logout) never set withCredentials', async () => {
    const spy = spyOn(axios, 'request').mockResolvedValue({ data: { ok: true } } as never);
    await sessionApi.getStatus('https://example.test');

    // Read the call record before `mockRestore()`, which clears it (like `mockReset()`).
    expect(spy).toHaveBeenCalledTimes(1);
    const config = spy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(config).toBeDefined();
    expect(config?.withCredentials).toBeUndefined();

    spy.mockRestore();
  });
});
