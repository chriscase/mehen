import { createHmac, randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { loadPrivateKey, signRequestV2 } from './authV2.js';

/**
 * DigitalEmpire agent-auth signing. Mirrors
 * `backend/src/services/agent-auth-service.ts#computeSignature` from the DE
 * server. The signed payload is `<timestamp>\n<nonce>\n<body>`, the HMAC key
 * is the SHA-256 hash of the agent's keySecret (kept in `MEHEN_AGENT_KEY_HASH`).
 *
 * Server cross-checks: keyId lookup, signature, timestamp skew (configurable
 * window on the server), nonce single-use.
 */
export interface SignedHeaders {
  'X-Agent-Key-Id': string;
  'X-Agent-Signature': string;
  'X-Agent-Timestamp': string;
  'X-Agent-Nonce': string;
}

export function signRequest(
  keyId: string,
  keyHash: string,
  body: string,
  now: Date = new Date(),
): SignedHeaders {
  // Server parses with `parseInt(ts, 10)` and treats as epoch milliseconds,
  // so the wire format is integer ms not ISO. Keep both sides in sync.
  const timestamp = String(now.getTime());
  const nonce = randomBytes(16).toString('hex');
  const payload = `${timestamp}\n${nonce}\n${body}`;
  const signature = createHmac('sha256', keyHash).update(payload).digest('hex');
  return {
    'X-Agent-Key-Id': keyId,
    'X-Agent-Signature': signature,
    'X-Agent-Timestamp': timestamp,
    'X-Agent-Nonce': nonce,
  };
}


/**
 * Sign a POST to `url` with whichever credential the config holds:
 * v2 (MEHEN_AGENT_KEY_FILE, Ed25519) when set, else v1 (key hash, HMAC).
 * DE chooses the verifier from the stored token, so this must match the
 * kind of token the key id was created as.
 */
export function signFor(config: Config, url: string, body: string): Record<string, string> {
  if (config.agentKeyFile) {
    return { ...signRequestV2(config.agentKeyId, loadPrivateKey(config.agentKeyFile), 'POST', url, body) };
  }
  if (!config.agentKeyHash) {
    throw new Error('No agent credential: set MEHEN_AGENT_KEY_FILE (v2) or MEHEN_AGENT_KEY_HASH/SECRET (v1)');
  }
  return { ...signRequest(config.agentKeyId, config.agentKeyHash, body) };
}
