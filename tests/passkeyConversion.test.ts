import { describe, expect, test } from 'bun:test';
import {
  arrayBufferToBase64Url,
  assertionOptionsFromJSON,
  base64UrlToArrayBuffer,
  creationOptionsFromJSON,
  guessDeviceName,
  supportsPasskeys,
} from '@/services/passkey';

describe('passkey base64url <-> ArrayBuffer conversion', () => {
  test('round-trips arbitrary byte sequences', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    const encoded = arrayBufferToBase64Url(bytes.buffer);
    const decoded = new Uint8Array(base64UrlToArrayBuffer(encoded));
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  test('round-trips a typed array view with a byte offset', () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 4, 9, 9]);
    const view = new Uint8Array(backing.buffer, 2, 4);
    const encoded = arrayBufferToBase64Url(view);
    const decoded = new Uint8Array(base64UrlToArrayBuffer(encoded));
    expect(Array.from(decoded)).toEqual([1, 2, 3, 4]);
  });

  test('produces URL-safe output with no padding', () => {
    // Byte sequence chosen so the standard base64 form contains both '+' and '/' and needs padding.
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const encoded = arrayBufferToBase64Url(bytes.buffer);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
    // Sanity check against the known standard-base64 form for these bytes.
    expect(encoded).toBe('-_-_');
  });

  test('decodes an unpadded base64url string using - and _ in place of + and /', () => {
    // Standard base64 for [0xfb, 0xff, 0xbf] is "+/+/" (no padding needed here); its base64url
    // form substitutes '-' for '+' and '_' for '/'.
    const decoded = new Uint8Array(base64UrlToArrayBuffer('-_-_'));
    expect(Array.from(decoded)).toEqual([0xfb, 0xff, 0xbf]);
  });

  test('decodes a base64url string that needs padding restored', () => {
    // [1, 2, 3] -> standard base64 "AQID" (4 chars, no padding). Use a length that needs it.
    const bytes = new Uint8Array([1, 2]);
    const encoded = arrayBufferToBase64Url(bytes.buffer); // "AQI" (3 chars -> needs 1 '=' pad)
    expect(encoded.length % 4).not.toBe(0);
    const decoded = new Uint8Array(base64UrlToArrayBuffer(encoded));
    expect(Array.from(decoded)).toEqual([1, 2]);
  });

  test('round-trips through both directions for empty input', () => {
    const encoded = arrayBufferToBase64Url(new Uint8Array([]).buffer);
    expect(encoded).toBe('');
    expect(new Uint8Array(base64UrlToArrayBuffer(encoded)).length).toBe(0);
  });
});

describe('supportsPasskeys', () => {
  test('is false outside a browser (no window.PublicKeyCredential)', () => {
    expect(supportsPasskeys()).toBe(false);
  });
});

describe('guessDeviceName', () => {
  test.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'iPhone'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'iPad'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 9)', 'Android device'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Mac'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)', 'Chromebook'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Windows PC'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'Linux device'],
    ['', 'This device'],
    ['some-unrecognized-agent', 'This device'],
  ])('maps %s -> %s', (ua, expected) => {
    expect(guessDeviceName(ua)).toBe(expected);
  });
});

describe('manual options fallback (no PublicKeyCredential.parse*FromJSON)', () => {
  test('assertionOptionsFromJSON decodes challenge and allowCredentials ids', () => {
    const challengeBytes = new Uint8Array([1, 2, 3, 4]);
    const credentialIdBytes = new Uint8Array([5, 6, 7, 8]);
    const json = {
      publicKey: {
        challenge: arrayBufferToBase64Url(challengeBytes.buffer),
        timeout: 60000,
        allowCredentials: [
          {
            type: 'public-key',
            id: arrayBufferToBase64Url(credentialIdBytes.buffer),
            transports: ['internal'],
          },
        ],
      },
    };

    const options = assertionOptionsFromJSON(json);
    const publicKey = options.publicKey as PublicKeyCredentialRequestOptions;

    expect(new Uint8Array(publicKey.challenge as ArrayBuffer)).toEqual(challengeBytes);
    expect(publicKey.timeout).toBe(60000);
    expect(publicKey.allowCredentials).toHaveLength(1);
    const decodedId = new Uint8Array(
      (publicKey.allowCredentials as PublicKeyCredentialDescriptor[])[0].id as ArrayBuffer
    );
    expect(decodedId).toEqual(credentialIdBytes);
  });

  test('assertionOptionsFromJSON tolerates a missing allowCredentials (discoverable login)', () => {
    const json = {
      publicKey: {
        challenge: arrayBufferToBase64Url(new Uint8Array([1]).buffer),
      },
    };

    const options = assertionOptionsFromJSON(json);
    const publicKey = options.publicKey as PublicKeyCredentialRequestOptions;
    expect(publicKey.allowCredentials).toBeUndefined();
  });

  test('creationOptionsFromJSON decodes challenge, user.id and excludeCredentials ids', () => {
    const challengeBytes = new Uint8Array([10, 20, 30]);
    const userIdBytes = new Uint8Array([40, 50, 60]);
    const excludedIdBytes = new Uint8Array([70, 80]);
    const json = {
      publicKey: {
        challenge: arrayBufferToBase64Url(challengeBytes.buffer),
        rp: { id: 'example.com', name: 'Example' },
        user: {
          id: arrayBufferToBase64Url(userIdBytes.buffer),
          name: 'admin',
          displayName: 'Admin',
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        excludeCredentials: [
          { type: 'public-key', id: arrayBufferToBase64Url(excludedIdBytes.buffer) },
        ],
      },
    };

    const options = creationOptionsFromJSON(json);
    const publicKey = options.publicKey as PublicKeyCredentialCreationOptions;

    expect(new Uint8Array(publicKey.challenge as ArrayBuffer)).toEqual(challengeBytes);
    expect(new Uint8Array(publicKey.user.id as ArrayBuffer)).toEqual(userIdBytes);
    expect(publicKey.user.name).toBe('admin');
    expect(publicKey.excludeCredentials).toHaveLength(1);
    const decodedExcludedId = new Uint8Array(
      (publicKey.excludeCredentials as PublicKeyCredentialDescriptor[])[0].id as ArrayBuffer
    );
    expect(decodedExcludedId).toEqual(excludedIdBytes);
  });
});
