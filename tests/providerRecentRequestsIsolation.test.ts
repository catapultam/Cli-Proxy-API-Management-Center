import { describe, expect, test } from 'bun:test';
import { createProviderRecentRequestsCacheController } from '../src/components/providers/hooks/useProviderRecentRequests';

describe('provider recent request cache isolation', () => {
  test('creates a fresh cache when the backend or identity version changes', () => {
    const controller = createProviderRecentRequestsCacheController();
    const serverA = controller.forScope('https://server-a.example', 1);
    serverA.cachedUsageByProvider = new Map([['provider-a', new Map()]]);
    serverA.cachedAt = Date.now();
    serverA.inFlightRequest = Promise.resolve(serverA.cachedUsageByProvider);

    const serverB = controller.forScope('https://server-b.example', 2);

    expect(serverB).not.toBe(serverA);
    expect(serverB.cachedUsageByProvider.size).toBe(0);
    expect(serverB.cachedAt).toBe(0);
    expect(serverB.inFlightRequest).toBeNull();

    serverA.cachedUsageByProvider = new Map([['late-provider-a', new Map()]]);
    expect(controller.forScope('https://server-b.example', 2)).toBe(serverB);
    expect(serverB.cachedUsageByProvider.size).toBe(0);
  });

  test('reuses the cache only within the same connection scope', () => {
    const controller = createProviderRecentRequestsCacheController();
    const first = controller.forScope('https://server.example', 1);

    expect(controller.forScope('https://server.example', 1)).toBe(first);
    expect(controller.forScope('https://server.example', 2)).not.toBe(first);
  });

  test('does not reset the cache on a session-token refresh (identityVersion unchanged)', () => {
    const controller = createProviderRecentRequestsCacheController();
    const first = controller.forScope('https://server.example', 5);
    first.cachedUsageByProvider = new Map([['provider-a', new Map()]]);
    first.cachedAt = Date.now();

    // Same apiBase, same identityVersion: a bearer-session token refresh does not bump
    // identityVersion, so the cache must survive it.
    const again = controller.forScope('https://server.example', 5);

    expect(again).toBe(first);
    expect(again.cachedUsageByProvider.size).toBe(1);
  });
});
