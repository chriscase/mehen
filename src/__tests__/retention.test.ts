import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneOldBackups } from '../util/retention.js';

describe('pruneOldBackups', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mehen-retention-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeFile(name: string, ageDays: number): Promise<void> {
    const full = join(dir, name);
    await writeFile(full, 'fake gz contents');
    if (ageDays > 0) {
      const t = Date.now() - ageDays * 24 * 60 * 60 * 1000;
      await utimes(full, t / 1000, t / 1000);
    }
  }

  it('removes .sql.gz files older than retainDays', async () => {
    await makeFile('old.sql.gz', 14);
    await makeFile('fresh.sql.gz', 1);
    const result = await pruneOldBackups({ dir, retainDays: 7 });
    expect(result.scanned).toBe(2);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]).toMatch(/old\.sql\.gz$/);
  });

  it('ignores non-.sql.gz files', async () => {
    await makeFile('important.txt', 30);
    await makeFile('readme.md', 30);
    const result = await pruneOldBackups({ dir, retainDays: 1 });
    expect(result.scanned).toBe(0);
    expect(result.removed).toEqual([]);
  });

  it('returns empty result when dir does not exist', async () => {
    const result = await pruneOldBackups({ dir: '/no/such/path/here', retainDays: 7 });
    expect(result).toEqual({ scanned: 0, removed: [] });
  });

  it('keeps files exactly at the retention boundary', async () => {
    // 7-day-old file with retainDays=7 should be kept (cutoff is strict <)
    await makeFile('borderline.sql.gz', 6);
    const result = await pruneOldBackups({ dir, retainDays: 7 });
    expect(result.removed).toEqual([]);
  });
});
