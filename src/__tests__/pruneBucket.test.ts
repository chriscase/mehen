import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../config.js';

const sendMock = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  ListObjectsV2Command: vi.fn().mockImplementation((input) => ({ input, _command: 'ListObjectsV2' })),
  DeleteObjectsCommand: vi.fn().mockImplementation((input) => ({ input, _command: 'DeleteObjects' })),
}));

import { pruneS3Backups, backupKeyDate } from '../storage/pruneBucket.js';

const baseConfig: Config = {
  backendUrl: 'https://de.example/',
  agentKeyId: 'k',
  agentKeyHash: 'h'.repeat(64),
  entityId: 'e',
  deployHost: 'osiris',
  backupDbs: [],
  backupDir: '/tmp',
  backupRetainDays: 7,
  s3RetainDays: 30,
  pgUseSudo: false,
  s3Endpoint: 'https://s3.example',
  s3Region: 'us-east-1',
  s3Bucket: 'bkt',
  s3AccessKey: 'a',
  s3SecretKey: 'b',
};

function isoDaysAgo(days: number): { year: string; month: string; day: string } {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return {
    year: String(d.getUTCFullYear()),
    month: String(d.getUTCMonth() + 1).padStart(2, '0'),
    day: String(d.getUTCDate()).padStart(2, '0'),
  };
}

function dumpKey(db: string, days: number, host = 'osiris'): string {
  const { year, month, day } = isoDaysAgo(days);
  return `${host}/${db}/${year}/${month}/${day}/dump.sql.gz`;
}

describe('backupKeyDate', () => {
  it('parses a well-formed dated dump key', () => {
    expect(backupKeyDate('osiris/db/2026/05/10/dump.sql.gz')).toBe(Date.UTC(2026, 4, 10));
  });

  it('returns null for non-dump, too-short, or malformed-date keys', () => {
    expect(backupKeyDate('osiris/db/2026/05/10/other.txt')).toBeNull();
    expect(backupKeyDate('osiris/db/dump.sql.gz')).toBeNull();
    expect(backupKeyDate('osiris/db/26/5/1/dump.sql.gz')).toBeNull();
    expect(backupKeyDate('random/object/key')).toBeNull();
  });
});

describe('pruneS3Backups', () => {
  beforeEach(() => sendMock.mockReset());

  it('deletes only dated dumps older than the retention window', async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [
          { Key: dumpKey('db-x', 60) }, // old → delete
          { Key: dumpKey('db-x', 40) }, // old → delete
          { Key: dumpKey('db-x', 5) }, // fresh → keep
          { Key: 'osiris/db-x/2026/05/10/notes.txt' }, // not a dump → ignore
          { Key: 'osiris/some-random-object' }, // unparseable → ignore
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Errors: [] }); // DeleteObjects response

    const res = await pruneS3Backups({ config: baseConfig, retainDays: 30 });

    expect(res.scanned).toBe(3); // only the 3 dated dumps
    expect(res.deleted).toEqual([dumpKey('db-x', 60), dumpKey('db-x', 40)]);
    // One list call + one delete call
    const deleteCall = sendMock.mock.calls.find((c) => c[0]?._command === 'DeleteObjects');
    expect(deleteCall?.[0].input.Delete.Objects).toEqual([
      { Key: dumpKey('db-x', 60) },
      { Key: dumpKey('db-x', 40) },
    ]);
  });

  it('scopes the listing to this host prefix', async () => {
    sendMock.mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    await pruneS3Backups({ config: baseConfig, retainDays: 30 });
    const listCall = sendMock.mock.calls.find((c) => c[0]?._command === 'ListObjectsV2');
    expect(listCall?.[0].input.Prefix).toBe('osiris/');
  });

  it('dry-run reports would-delete and issues no DeleteObjects', async () => {
    sendMock.mockResolvedValueOnce({
      Contents: [{ Key: dumpKey('db-x', 90) }, { Key: dumpKey('db-x', 1) }],
      IsTruncated: false,
    });
    const res = await pruneS3Backups({ config: baseConfig, retainDays: 30, dryRun: true });
    expect(res.wouldDelete).toEqual([dumpKey('db-x', 90)]);
    expect(res.deleted).toEqual([]);
    expect(sendMock.mock.calls.some((c) => c[0]?._command === 'DeleteObjects')).toBe(false);
  });

  it('retainDays <= 0 disables pruning entirely (no S3 calls)', async () => {
    const res = await pruneS3Backups({ config: baseConfig, retainDays: 0 });
    expect(res).toEqual({ scanned: 0, deleted: [], wouldDelete: [] });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
