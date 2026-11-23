import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * DigitalEmpire agent protocol v2 (Ed25519) signing. Mirrors DE's
 * `backend/src/services/agent-signing-v2.ts`; the spec is DE's
 * `docs/AGENT_PROTOCOL_V2.md` and both sides are checked against the same
 * test vectors (`src/__tests__/fixtures/agent-signing-v2.vectors.json`, a copy
 * of DE's `shared/protocols/agent-signing-v2.vectors.json`).
 *
 * The private key (PKCS#8 PEM) stays on this host; DE stores only the public
 * key, so a DE database dump cannot forge this agent (unlike v1, whose stored
 * key hash is also the HMAC key).
 */
export const V2_PREFIX = 'DE-AGENT-V2';

export interface SigningInputV2 {
  method: string;
  /** Request target as sent: path plus `?query` if any. */
  path: string;
  timestamp: string;
  nonce: string;
  body: string | Buffer;
}

export function canonicalStringV2(i: SigningInputV2): string {
  const bodySha = createHash('sha256').update(i.body).digest('hex');
  return [V2_PREFIX, i.method.toUpperCase(), i.path, i.timestamp, i.nonce, bodySha].join('\n');
}

export function signV2(priv: KeyObject, i: SigningInputV2): string {
  return sign(null, Buffer.from(canonicalStringV2(i), 'utf8'), priv).toString('hex');
}

const keyCache = new Map<string, KeyObject>();

/** Load (and cache) an Ed25519 PKCS#8 PEM private key. */
export function loadPrivateKey(path: string): KeyObject {
  let key = keyCache.get(path);
  if (!key) {
    key = createPrivateKey(readFileSync(path, 'utf8'));
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error(`${path} is not an Ed25519 private key`);
    }
    keyCache.set(path, key);
  }
  return key;
}

/** 64-hex-char public key, the form DE's agent-token registration expects. */
export function publicKeyHex(priv: KeyObject): string {
  const der = createPublicKey(priv).export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32).toString('hex');
}

/** New key pair: PKCS#8 PEM private key + public key hex. */
export function generateKeyPairV2(): { privatePem: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKeyHex(privateKey),
  };
}

export interface SignedHeadersV2 {
  'X-Agent-Key-Id': string;
  'X-Agent-Signature': string;
  'X-Agent-Timestamp': string;
  'X-Agent-Nonce': string;
  'X-Agent-Signature-Version': '2';
}

/** Sign one HTTP request. `url` is the full URL that will be fetched. */
export function signRequestV2(
  keyId: string,
  priv: KeyObject,
  method: string,
  url: string,
  body: string,
  now: Date = new Date(),
): SignedHeadersV2 {
  const u = new URL(url);
  const timestamp = String(now.getTime());
  const nonce = randomBytes(16).toString('hex');
  const signature = signV2(priv, { method, path: u.pathname + u.search, timestamp, nonce, body });
  return {
    'X-Agent-Key-Id': keyId,
    'X-Agent-Signature': signature,
    'X-Agent-Timestamp': timestamp,
    'X-Agent-Nonce': nonce,
    'X-Agent-Signature-Version': '2',
  };
}
