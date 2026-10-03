import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import type { ApiError } from '@/types';

/**
 * Exercises `ApiClient`'s private `handleError` directly. Axios's own `isAxiosError` is a duck
 * type (`payload.isAxiosError === true`), so a plain object with that shape is indistinguishable
 * from a real Axios error to the code under test — this avoids needing to mock a whole HTTP
 * transport/adapter just to drive the response-error interceptor.
 */
type PrivateApiClient = {
  handleError: (error: unknown) => ApiError;
};

function callHandleError(error: unknown): ApiError {
  return (apiClient as unknown as PrivateApiClient).handleError(error);
}

function fakeAxiosError(status: number, config: Record<string, unknown> = {}) {
  return {
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: { status, data: { error: 'something went wrong' } },
    config,
  };
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

class FakeWindow extends EventTarget {}

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: new FakeWindow(),
  });
});

afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

afterEach(() => {
  apiClient.setIdentityVersion(0);
  apiClient.setConfig({ apiBase: '', managementKey: '' });
});

function captureUnauthorized(run: () => void): boolean {
  let fired = false;
  const listener = () => {
    fired = true;
  };
  window.addEventListener('unauthorized', listener);
  try {
    run();
  } finally {
    window.removeEventListener('unauthorized', listener);
  }
  return fired;
}

describe('ApiClient 401 handling', () => {
  test('a 401 for the current identity dispatches unauthorized', () => {
    apiClient.setIdentityVersion(5);
    const fired = captureUnauthorized(() => {
      callHandleError(fakeAxiosError(401, { __identityVersion: 5 }));
    });
    expect(fired).toBe(true);
  });

  test('a 401 with no stamped identity (e.g. a request predating this change) still dispatches', () => {
    apiClient.setIdentityVersion(5);
    const fired = captureUnauthorized(() => {
      callHandleError(fakeAxiosError(401, {}));
    });
    expect(fired).toBe(true);
  });

  test('ignores a 401 from a request stamped with an older identityVersion', () => {
    apiClient.setIdentityVersion(5);
    const fired = captureUnauthorized(() => {
      // Simulates a slow response landing after the identity already moved on (new login/logout).
      callHandleError(fakeAxiosError(401, { __identityVersion: 3 }));
    });
    expect(fired).toBe(false);
  });

  test('suspendUnauthorizedHandling() suppresses the dispatch until released', () => {
    apiClient.setIdentityVersion(1);
    const release = apiClient.suspendUnauthorizedHandling();

    const firedWhileSuspended = captureUnauthorized(() => {
      callHandleError(fakeAxiosError(401, { __identityVersion: 1 }));
    });
    expect(firedWhileSuspended).toBe(false);

    release();

    const firedAfterRelease = captureUnauthorized(() => {
      callHandleError(fakeAxiosError(401, { __identityVersion: 1 }));
    });
    expect(firedAfterRelease).toBe(true);
  });

  test('suspendUnauthorizedHandling() nests: only the outermost release re-enables dispatch', () => {
    apiClient.setIdentityVersion(1);
    const releaseOuter = apiClient.suspendUnauthorizedHandling();
    const releaseInner = apiClient.suspendUnauthorizedHandling();

    releaseInner();
    const stillSuspended = captureUnauthorized(() => {
      callHandleError(fakeAxiosError(401, { __identityVersion: 1 }));
    });
    expect(stillSuspended).toBe(false);

    releaseOuter();
    const resumed = captureUnauthorized(() => {
      callHandleError(fakeAxiosError(401, { __identityVersion: 1 }));
    });
    expect(resumed).toBe(true);
  });

  test('release() is idempotent', () => {
    apiClient.setIdentityVersion(1);
    const release = apiClient.suspendUnauthorizedHandling();
    release();
    release();
    release();

    const fired = captureUnauthorized(() => {
      callHandleError(fakeAxiosError(401, { __identityVersion: 1 }));
    });
    expect(fired).toBe(true);
  });
});

describe('non-401 account/passkey errors never log out (B2)', () => {
  test.each([400, 403, 409, 410, 429])(
    'a %d response (e.g. a 410 from passkeys/finish: expired/used ceremony) never dispatches unauthorized',
    (status) => {
      apiClient.setIdentityVersion(1);
      const fired = captureUnauthorized(() => {
        const apiError = callHandleError(fakeAxiosError(status, { __identityVersion: 1 }));
        expect(apiError.status).toBe(status);
      });
      expect(fired).toBe(false);
    }
  );

  test('a 410 from passkeys/finish is surfaced as a normal ApiError, not swallowed', () => {
    const apiError = callHandleError(fakeAxiosError(410, { __identityVersion: 1 }));
    expect(apiError.status).toBe(410);
    expect(apiError.name).toBe('ApiError');
  });
});
