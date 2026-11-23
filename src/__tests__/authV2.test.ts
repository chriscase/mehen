import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { canonicalStringV2, generateKeyPairV2, publicKeyHex, signRequestV2, signV2 } from '../authV2.js';
import { signFor } from '../auth.js';
import { loadConfigFromEnv } from '../config.js';

// Copy of DigitalEmpire's shared/protocols/agent-signing-v2.vectors.json.
interface Vec { name: string; method: string; path: string; timestamp: string; nonce: string; body: string; canonical?: string; signature: string }
const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/agent-signing-v2.vectors.json', import.meta.url), 'utf8'),
) as { privateKeySeedHex: string; publicKey: string; valid: Vec[]; invalid: Vec[] };

const priv = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(vectors.privateKeySeedHex, 'hex')]),
  format: 'der',
  type: 'pkcs8',
});
const pub = createPublicKey(priv);

describe('DE agent protocol v2 vectors', () => {
  it('derives the vectors public key', () => {
    expect(publicKeyHex(priv)).toBe(vectors.publicKey);
  });

  it.each(vectors.valid.map((v) => [v.name, v] as const))('%s reproduces exactly', (_n, v) => {
    expect(canonicalStringV2(v)).toBe(v.canonical);
    expect(signV2(priv, v)).toBe(v.signature);
  });

  it.each(vectors.invalid.map((v) => [v.name, v] as const))('%s does not verify', (_n, v) => {
    expect(verify(null, Buffer.from(canonicalStringV2(v)), pub, Buffer.from(v.signature, 'hex'))).toBe(false);
  });
});

describe('signRequestV2', () => {
  it('signs the URL path + query and sends the version header', () => {
    const fixed = new Date('2026-11-23T00:00:00Z');
    const body = '{"entityId":"isis-prod","status":"success"}';
    const h = signRequestV2('agk_v2', priv, 'POST', 'https://de.example/api/agent/backup-run?x=1', body, fixed);
    expect(h['X-Agent-Signature-Version']).toBe('2');
    expect(h['X-Agent-Nonce']).toMatch(/^[0-9a-f]{32}$/);
    const expected = signV2(priv, { method: 'POST', path: '/api/agent/backup-run?x=1', timestamp: h['X-Agent-Timestamp'], nonce: h['X-Agent-Nonce'], body });
    expect(h['X-Agent-Signature']).toBe(expected);
  });
});

describe('credential selection', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  const base = {
    MEHEN_BACKEND_URL: 'https://de.example', MEHEN_AGENT_KEY_ID: 'agk_x', MEHEN_ENTITY_ID: 'isis-prod',
    MEHEN_DEPLOY_HOST: 'isis', MEHEN_BACKUP_DBS: 'a',
  };

  it('uses v2 when MEHEN_AGENT_KEY_FILE is set (and ignores a leftover v1 secret)', () => {
    dir = mkdtempSync(join(tmpdir(), 'mehen-'));
    const keyPath = join(dir, 'agent.key');
    const { privatePem, publicKey } = generateKeyPairV2();
    writeFileSync(keyPath, privatePem, { mode: 0o600 });
    const config = loadConfigFromEnv({ ...base, MEHEN_AGENT_KEY_FILE: keyPath, MEHEN_AGENT_KEY_SECRET: 'ags_old' });
    expect(config.agentKeyHash).toBeUndefined();
    const h = signFor(config, 'https://de.example/api/agent/backup-run', '{}');
    expect(h['X-Agent-Signature-Version']).toBe('2');
    expect(h['X-Agent-Signature']).toMatch(/^[0-9a-f]{128}$/);
    expect(publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('falls back to v1 with a key hash', () => {
    const config = loadConfigFromEnv({ ...base, MEHEN_AGENT_KEY_HASH: 'a'.repeat(64) });
    const h = signFor(config, 'https://de.example/api/agent/backup-run', '{}');
    expect(h['X-Agent-Signature-Version']).toBeUndefined();
    expect(h['X-Agent-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a config with no credential', () => {
    expect(() => loadConfigFromEnv(base)).toThrow(/exactly one agent credential/);
  });
});
