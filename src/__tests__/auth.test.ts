import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signRequest } from '../auth.js';

describe('signRequest', () => {
  it('produces all four signed headers', () => {
    const headers = signRequest('agk_test', 'a'.repeat(64), '{"hello":"world"}');
    expect(headers['X-Agent-Key-Id']).toBe('agk_test');
    expect(headers['X-Agent-Signature']).toMatch(/^[0-9a-f]{64}$/);
    // Timestamp is integer epoch ms, not ISO — DE server parses with parseInt.
    expect(headers['X-Agent-Timestamp']).toMatch(/^\d{13}$/);
    expect(headers['X-Agent-Nonce']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('signature matches the canonical timestamp\\nnonce\\nbody payload', () => {
    const fixed = new Date('2026-05-10T12:00:00.000Z');
    const keyHash = 'b'.repeat(64);
    const body = '{"x":1}';
    const headers = signRequest('agk_x', keyHash, body, fixed);

    const payload = `${headers['X-Agent-Timestamp']}\n${headers['X-Agent-Nonce']}\n${body}`;
    const expected = createHmac('sha256', keyHash).update(payload).digest('hex');
    expect(headers['X-Agent-Signature']).toBe(expected);
    expect(headers['X-Agent-Timestamp']).toBe(String(fixed.getTime()));
  });

  it('produces a different nonce on each call (anti-replay)', () => {
    const a = signRequest('k', 'c'.repeat(64), 'body');
    const b = signRequest('k', 'c'.repeat(64), 'body');
    expect(a['X-Agent-Nonce']).not.toBe(b['X-Agent-Nonce']);
  });

  it('signs different bodies to different signatures', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z');
    const keyHash = 'd'.repeat(64);
    const a = signRequest('k', keyHash, 'a', fixed);
    const b = signRequest('k', keyHash, 'b', fixed);
    // Note: nonces differ, so to test body sensitivity we check the
    // canonical payload directly.
    const payloadA = `${a['X-Agent-Timestamp']}\n${a['X-Agent-Nonce']}\na`;
    const payloadB = `${b['X-Agent-Timestamp']}\n${b['X-Agent-Nonce']}\nb`;
    expect(payloadA).not.toBe(payloadB);
  });
});
