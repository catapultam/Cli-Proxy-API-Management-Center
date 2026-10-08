import { describe, expect, test } from 'bun:test';
import { httpsPasskeyOriginForHttpPage } from '@/services/passkey';

const ORIGINS = ['https://cakebox.wyrm-cat.ts.net:8443'];
const http = { protocol: 'http:', hostname: 'cakebox.wyrm-cat.ts.net' };

describe('httpsPasskeyOriginForHttpPage', () => {
  test('points an HTTP page at the HTTPS passkey origin for the same host', () => {
    expect(httpsPasskeyOriginForHttpPage(ORIGINS, true, http)).toBe(ORIGINS[0]);
  });

  test('returns nothing on an HTTPS page (the passkey button itself is shown there)', () => {
    expect(httpsPasskeyOriginForHttpPage(ORIGINS, true, { ...http, protocol: 'https:' })).toBe(
      null
    );
  });

  test('returns nothing when passkeys are unavailable', () => {
    expect(httpsPasskeyOriginForHttpPage(ORIGINS, false, http)).toBe(null);
  });

  test('never links to a different host', () => {
    expect(httpsPasskeyOriginForHttpPage(ORIGINS, true, { ...http, hostname: '127.0.0.1' })).toBe(
      null
    );
    expect(
      httpsPasskeyOriginForHttpPage(['not a url', 'http://cakebox.wyrm-cat.ts.net'], true, http)
    ).toBe(null);
  });
});
