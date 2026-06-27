import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../config.js';

const sendMock = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  ListObjectsV2Command: vi.fn().mockImplementation((input) => ({ input, _command: 'ListObjectsV2' })),
}));

import { scanBucket } from '../storage/listBucket.js';

const baseConfig: Config = {
  backendUrl: 'https://de.example/',
  agentKeyId: 'k',
  agentKeyHash: 'h'.repeat(64),
  entityId: 'e',
  deployHost: 'h',
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

function obj(key: string, size: number) {
  return { Key: key, Size: size };
}

describe('scanBucket', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('aggregates totals + per-prefix usage', async () => {
    sendMock.mockResolvedValueOnce({
      Contents: [
        obj('osiris/db-x/2026/05/10/dump.sql.gz', 1000),
        obj('osiris/db-x/2026/05/11/dump.sql.gz', 2000),
        obj('osiris/db-y/2026/05/10/dump.sql.gz', 500),
        obj('isis/db-z/2026/05/10/dump.sql.gz', 7000),
      ],
      IsTruncated: false,
    });

    const res = await scanBucket(baseConfig);
    expect(res.totalBytes).toBe(10500);
    expect(res.objectCount).toBe(4);
    // Prefix depth defaults to 2 → host/db
    const prefixMap = Object.fromEntries(res.prefixes.map((p) => [p.prefix, p]));
    expect(prefixMap['osiris/db-x']).toEqual({ prefix: 'osiris/db-x', bytes: 3000, count: 2 });
    expect(prefixMap['osiris/db-y']).toEqual({ prefix: 'osiris/db-y', bytes: 500, count: 1 });
    expect(prefixMap['isis/db-z']).toEqual({ prefix: 'isis/db-z', bytes: 7000, count: 1 });
    // Sorted descending by bytes
    expect(res.prefixes[0].prefix).toBe('isis/db-z');
  });

  it('paginates through ContinuationToken', async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [obj('a/x/1', 100), obj('a/x/2', 100)],
        IsTruncated: true,
        NextContinuationToken: 'tok-1',
      })
      .mockResolvedValueOnce({
        Contents: [obj('b/y/1', 200)],
        IsTruncated: false,
      });

    const res = await scanBucket(baseConfig);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(res.objectCount).toBe(3);
    expect(res.totalBytes).toBe(400);
  });

  it('folds tail prefixes into "other" when over maxPrefixes', async () => {
    const contents = Array.from({ length: 10 }, (_, i) => obj(`host${i}/db/file`, 10 - i));
    sendMock.mockResolvedValueOnce({ Contents: contents, IsTruncated: false });

    const res = await scanBucket(baseConfig, { maxPrefixes: 3 });
    // Expect 3 entries: top 2 + 'other'
    expect(res.prefixes).toHaveLength(3);
    expect(res.prefixes[res.prefixes.length - 1].prefix).toBe('other');
    // 'other' rolls up the remaining 8 entries
    expect(res.prefixes[res.prefixes.length - 1].count).toBe(8);
  });

  it('handles empty bucket gracefully', async () => {
    sendMock.mockResolvedValueOnce({ Contents: undefined, IsTruncated: false });
    const res = await scanBucket(baseConfig);
    expect(res.totalBytes).toBe(0);
    expect(res.objectCount).toBe(0);
    expect(res.prefixes).toEqual([]);
  });

  it('throws when S3 not configured', async () => {
    const noS3: Config = { ...baseConfig, s3Bucket: undefined };
    await expect(scanBucket(noS3)).rejects.toThrow(/S3 not configured/);
  });
});
