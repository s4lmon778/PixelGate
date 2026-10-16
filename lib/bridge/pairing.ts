import { strFromU8, strToU8, unzlibSync, zlibSync } from 'fflate';
import { onlyKeys, validateSignal } from '../pairing-validation';

export const PAIR_TTL = 10 * 60 * 1000;
const MAX_TOKEN = 16000;
const MAX_DECODED = 32768;
export interface PairSignal {
  version: 1;
  id: string;
  expires: number;
  description: RTCSessionDescriptionInit;
}
function validate(
  raw: unknown,
  kind: 'offer' | 'answer',
  now: number,
): PairSignal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid pairing data.');
  const value = raw as PairSignal;
  onlyKeys(value as unknown as Record<string, unknown>, [
    'version',
    'id',
    'expires',
    'description',
  ]);
  if (
    value.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    !Number.isSafeInteger(value.expires)
  )
    throw new Error('Unsupported or invalid pairing data.');
  if (value.expires <= now)
    throw new Error('This pairing link has expired. Create a new connection.');
  if (value.expires > now + PAIR_TTL + 120000)
    throw new Error('Pairing expiry is invalid. Check both devices’ clocks.');
  validateSignal(value.description, kind);
  return value;
}
export function encodePair(signal: PairSignal) {
  const json = strToU8(JSON.stringify(signal));
  if (json.length > MAX_DECODED)
    throw new Error('Connection description is too large.');
  const bytes = zlibSync(json, { level: 6 });
  const encoded = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  if (encoded.length > MAX_TOKEN) throw new Error('Pairing data is too large.');
  return `pg1.${encoded}`;
}
export function decodePair(
  input: string,
  kind: 'offer' | 'answer',
  now = Date.now(),
): PairSignal {
  if (input.length > MAX_TOKEN + 2048)
    throw new Error('Pairing data is too large.');
  let token = input.trim();
  if (/^https?:\/\//.test(token)) {
    const params = new URLSearchParams(new URL(token).hash.slice(1));
    token = params.get('connect') ?? params.get('response') ?? '';
  }
  if (token.length > MAX_TOKEN + 4)
    throw new Error('Pairing data is too large.');
  if (!/^pg1\.[A-Za-z0-9_-]+$/.test(token))
    throw new Error('Paste a PixelGate pairing link or response.');
  try {
    const binary = atob(token.slice(4).replace(/-/g, '+').replace(/_/g, '/'));
    // A fixed output buffer caps memory even for a malicious compressed token.
    const bytes = unzlibSync(
      Uint8Array.from(binary, (c) => c.charCodeAt(0)),
      { out: new Uint8Array(MAX_DECODED + 1) },
    );
    if (bytes.length > MAX_DECODED)
      throw new Error('Pairing data is too large.');
    return validate(JSON.parse(strFromU8(bytes)), kind, now);
  } catch (error) {
    if (
      error instanceof Error &&
      /expired|expiry|Unsupported|large|bounded|Unexpected/.test(error.message)
    )
      throw error;
    throw new Error(
      'Invalid pairing data. Copy the complete link or response and try again.',
    );
  }
}
export function pairingLink(token: string) {
  return `${location.origin}${location.pathname}#connect=${token}`;
}
