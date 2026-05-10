import { describe, it, expect, vi } from 'vitest';
import { userGrowthScan } from '../scan/modules/userGrowth.js';
import { superAdminChangesScan } from '../scan/modules/superAdminChanges.js';
import { unverifiedAccountsScan } from '../scan/modules/unverifiedAccounts.js';

const ctx = { database: 'test_db', detectedAt: new Date('2026-05-10T00:00:00Z') };

describe('userGrowthScan', () => {
  it('returns no findings when growth is below 10/day', async () => {
    const query = vi.fn().mockResolvedValue([{ count: '5' }]);
    expect(await userGrowthScan.run(query, ctx)).toEqual([]);
  });

  it('returns warn at 10–25 new users', async () => {
    const query = vi.fn().mockResolvedValue([{ count: '15' }]);
    const findings = await userGrowthScan.run(query, ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warn');
  });

  it('returns alert at 25–100', async () => {
    const query = vi.fn().mockResolvedValue([{ count: '50' }]);
    const findings = await userGrowthScan.run(query, ctx);
    expect(findings[0].severity).toBe('alert');
  });

  it('returns critical at >100', async () => {
    const query = vi.fn().mockResolvedValue([{ count: '500' }]);
    const findings = await userGrowthScan.run(query, ctx);
    expect(findings[0].severity).toBe('critical');
  });

  it('returns no findings when the User table does not exist', async () => {
    const query = vi.fn().mockRejectedValue(new Error('relation "User" does not exist'));
    expect(await userGrowthScan.run(query, ctx)).toEqual([]);
  });
});

describe('superAdminChangesScan', () => {
  it('returns no findings when nothing changed', async () => {
    const query = vi.fn().mockResolvedValue([{ count: '0' }]);
    expect(await superAdminChangesScan.run(query, ctx)).toEqual([]);
  });

  it('flags any grant or revoke', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ count: '1' }])
      .mockResolvedValueOnce([{ count: '0' }]);
    const findings = await superAdminChangesScan.run(query, ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warn');
    expect(findings[0].context).toEqual({ granted: 1, revoked: 0, window: '24h' });
  });

  it('skips databases without SuperAdminGrant', async () => {
    const query = vi.fn().mockRejectedValue(new Error('relation "SuperAdminGrant" does not exist'));
    expect(await superAdminChangesScan.run(query, ctx)).toEqual([]);
  });
});

describe('unverifiedAccountsScan', () => {
  it('returns no findings below threshold', async () => {
    const query = vi.fn().mockResolvedValue([{ count: '2' }]);
    expect(await unverifiedAccountsScan.run(query, ctx)).toEqual([]);
  });

  it('returns info at 5–50', async () => {
    const query = vi.fn().mockResolvedValue([{ count: '20' }]);
    const findings = await unverifiedAccountsScan.run(query, ctx);
    expect(findings[0].severity).toBe('info');
  });

  it('escalates to alert at >50', async () => {
    const query = vi.fn().mockResolvedValue([{ count: '100' }]);
    const findings = await unverifiedAccountsScan.run(query, ctx);
    expect(findings[0].severity).toBe('alert');
  });
});
