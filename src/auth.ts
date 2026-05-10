import { createHmac, randomBytes } from 'node:crypto';

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
  const timestamp = now.toISOString();
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
