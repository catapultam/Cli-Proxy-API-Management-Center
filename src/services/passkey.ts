/**
 * WebAuthn (passkey) ceremony helpers.
 *
 * Prefers the newer `PublicKeyCredential.parseRequestOptionsFromJSON` /
 * `parseCreationOptionsFromJSON` static methods and `credential.toJSON()` instance method.
 * Falls back to manual base64url <-> ArrayBuffer conversion for browsers that do not implement
 * them yet. The backend (go-webauthn) exchanges `protocol.CredentialAssertion` /
 * `protocol.CredentialCreation` JSON (`{ "publicKey": { ... } }`) and expects `credential.toJSON()`
 * output back.
 */

type JsonRecord = Record<string, unknown>;

/** Decodes an unpadded, URL-safe base64 string into an ArrayBuffer. */
export function base64UrlToArrayBuffer(base64url: string): ArrayBuffer {
  const normalized = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Encodes an ArrayBuffer (or typed array view) into an unpadded, URL-safe base64 string. */
export function arrayBufferToBase64Url(input: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Whether this browser can attempt WebAuthn ceremonies at all. */
export function supportsPasskeys(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
}

/** Best-effort default name for the "add a passkey" prompt, guessed from the UA string. */
/**
 * Passkeys never work over plain HTTP. When the page is HTTP and an HTTPS passkey origin exists
 * for the same host, return it so the login form can link there instead of hiding passkeys.
 */
export function httpsPasskeyOriginForHttpPage(
  origins: string[],
  passkeysAvailable: boolean,
  location: Pick<Location, 'protocol' | 'hostname'>
): string | null {
  if (!passkeysAvailable || location.protocol !== 'http:') return null;
  return (
    origins.find((origin) => {
      try {
        const url = new URL(origin);
        return url.protocol === 'https:' && url.hostname === location.hostname;
      } catch {
        return false;
      }
    }) ?? null
  );
}

export function guessDeviceName(userAgent: string): string {
  const ua = userAgent || '';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android device';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/CrOS/i.test(ua)) return 'Chromebook';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Linux/i.test(ua)) return 'Linux device';
  return 'This device';
}

function hasNativeStaticMethod(
  methodName: 'parseRequestOptionsFromJSON' | 'parseCreationOptionsFromJSON'
): boolean {
  if (typeof PublicKeyCredential === 'undefined') return false;
  const candidate = (PublicKeyCredential as unknown as Record<string, unknown>)[methodName];
  return typeof candidate === 'function';
}

function convertDescriptorJSON(descriptor: JsonRecord): PublicKeyCredentialDescriptor {
  return {
    ...descriptor,
    id: base64UrlToArrayBuffer(descriptor.id as string),
  } as PublicKeyCredentialDescriptor;
}

/**
 * Converts a go-webauthn `protocol.CredentialAssertion` JSON body (the `options` field of
 * `POST session/passkey/begin`) into `CredentialRequestOptions` for `navigator.credentials.get`.
 */
export function assertionOptionsFromJSON(input: {
  publicKey: JsonRecord;
}): CredentialRequestOptions {
  if (hasNativeStaticMethod('parseRequestOptionsFromJSON')) {
    const parse = (
      PublicKeyCredential as unknown as {
        parseRequestOptionsFromJSON: (json: JsonRecord) => PublicKeyCredentialRequestOptions;
      }
    ).parseRequestOptionsFromJSON;
    return { publicKey: parse(input.publicKey) };
  }

  const publicKey = input.publicKey;
  const allowCredentials = Array.isArray(publicKey.allowCredentials)
    ? (publicKey.allowCredentials as JsonRecord[]).map(convertDescriptorJSON)
    : undefined;

  return {
    publicKey: {
      ...publicKey,
      challenge: base64UrlToArrayBuffer(publicKey.challenge as string),
      ...(allowCredentials ? { allowCredentials } : {}),
    } as PublicKeyCredentialRequestOptions,
  };
}

/**
 * Converts a go-webauthn `protocol.CredentialCreation` JSON body (the `options` field of
 * `POST account/passkeys/begin`) into `CredentialCreationOptions` for `navigator.credentials.create`.
 */
export function creationOptionsFromJSON(input: {
  publicKey: JsonRecord;
}): CredentialCreationOptions {
  if (hasNativeStaticMethod('parseCreationOptionsFromJSON')) {
    const parse = (
      PublicKeyCredential as unknown as {
        parseCreationOptionsFromJSON: (json: JsonRecord) => PublicKeyCredentialCreationOptions;
      }
    ).parseCreationOptionsFromJSON;
    return { publicKey: parse(input.publicKey) };
  }

  const publicKey = input.publicKey;
  const user = publicKey.user as JsonRecord;
  const excludeCredentials = Array.isArray(publicKey.excludeCredentials)
    ? (publicKey.excludeCredentials as JsonRecord[]).map(convertDescriptorJSON)
    : undefined;

  return {
    publicKey: {
      ...publicKey,
      challenge: base64UrlToArrayBuffer(publicKey.challenge as string),
      user: {
        ...user,
        id: base64UrlToArrayBuffer(user.id as string),
      },
      ...(excludeCredentials ? { excludeCredentials } : {}),
    } as PublicKeyCredentialCreationOptions,
  };
}

interface AttestationLikeResponse {
  clientDataJSON: ArrayBuffer;
  attestationObject: ArrayBuffer;
  getTransports?: () => string[];
}

interface AssertionLikeResponse {
  clientDataJSON: ArrayBuffer;
  authenticatorData: ArrayBuffer;
  signature: ArrayBuffer;
  userHandle?: ArrayBuffer | null;
}

const isAttestationLikeResponse = (response: unknown): response is AttestationLikeResponse =>
  typeof response === 'object' && response !== null && 'attestationObject' in response;

const isAssertionLikeResponse = (response: unknown): response is AssertionLikeResponse =>
  typeof response === 'object' && response !== null && 'authenticatorData' in response;

/**
 * Converts a ceremony result `PublicKeyCredential` into the JSON shape the backend expects.
 *
 * Duck-types the response (attestation vs. assertion) by its fields rather than
 * `instanceof AuthenticatorAttestationResponse`/`AuthenticatorAssertionResponse`: those globals
 * don't exist outside a browser, which would make this fallback untestable, and duck-typing is
 * no less correct since the two shapes never overlap.
 */
export function credentialToJSON(credential: PublicKeyCredential): JsonRecord {
  const asJsonCapable = credential as unknown as { toJSON?: () => JsonRecord };
  if (typeof asJsonCapable.toJSON === 'function') {
    return asJsonCapable.toJSON();
  }

  const response = credential.response;
  const base: JsonRecord = {
    id: credential.id,
    rawId: arrayBufferToBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
  };

  if (isAttestationLikeResponse(response)) {
    base.response = {
      clientDataJSON: arrayBufferToBase64Url(response.clientDataJSON),
      attestationObject: arrayBufferToBase64Url(response.attestationObject),
      transports:
        typeof response.getTransports === 'function' ? response.getTransports() : undefined,
    };
  } else if (isAssertionLikeResponse(response)) {
    base.response = {
      clientDataJSON: arrayBufferToBase64Url(response.clientDataJSON),
      authenticatorData: arrayBufferToBase64Url(response.authenticatorData),
      signature: arrayBufferToBase64Url(response.signature),
      userHandle: response.userHandle ? arrayBufferToBase64Url(response.userHandle) : null,
    };
  }

  return base;
}
