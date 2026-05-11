import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { Config } from '../config.js';

export interface PrefixUsage {
  prefix: string;
  bytes: number;
  count: number;
}

export interface BucketScanResult {
  bucket: string;
  endpoint: string;
  totalBytes: number;
  objectCount: number;
  prefixes: PrefixUsage[];
}

export interface ScanOptions {
  /** How many leading path segments define a "prefix" bucket (default 2). */
  prefixDepth?: number;
  /** Hard cap on prefix entries kept (default 200). Smallest entries get folded into 'other'. */
  maxPrefixes?: number;
}

/**
 * Walk an S3-compatible bucket and aggregate object usage by leading path
 * segments. Returns total bytes/count plus a per-prefix breakdown so the
 * dashboard can show where storage is concentrated without keeping a row
 * for every object.
 *
 * Uses ListObjectsV2 with continuation tokens — works on any bucket size,
 * one round-trip per 1000 keys.
 */
export async function scanBucket(
  config: Config,
  opts: ScanOptions = {},
): Promise<BucketScanResult> {
  if (
    !config.s3Endpoint ||
    !config.s3Region ||
    !config.s3Bucket ||
    !config.s3AccessKey ||
    !config.s3SecretKey
  ) {
    throw new Error('S3 not configured (need endpoint, region, bucket, accessKey, secretKey)');
  }

  const prefixDepth = opts.prefixDepth ?? 2;
  const maxPrefixes = opts.maxPrefixes ?? 200;

  const client = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    credentials: {
      accessKeyId: config.s3AccessKey,
      secretAccessKey: config.s3SecretKey,
    },
    forcePathStyle: true,
  });

  let totalBytes = 0;
  let objectCount = 0;
  const byPrefix = new Map<string, { bytes: number; count: number }>();
  let continuationToken: string | undefined;

  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: config.s3Bucket,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      const size = obj.Size ?? 0;
      const key = obj.Key ?? '';
      totalBytes += size;
      objectCount += 1;
      const prefix = key.split('/').slice(0, prefixDepth).join('/') || '(root)';
      const cur = byPrefix.get(prefix) ?? { bytes: 0, count: 0 };
      cur.bytes += size;
      cur.count += 1;
      byPrefix.set(prefix, cur);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  const prefixes = foldSmallest(
    Array.from(byPrefix.entries()).map(([prefix, u]) => ({ prefix, ...u })),
    maxPrefixes,
  );

  return {
    bucket: config.s3Bucket,
    endpoint: config.s3Endpoint,
    totalBytes,
    objectCount,
    prefixes,
  };
}

/**
 * Keep the top `max-1` prefixes and roll the rest into a single 'other'
 * row. Avoids unbounded payload sizes on buckets with many tiny prefixes
 * while keeping the headline 'which prefixes own most of the bytes' signal.
 */
function foldSmallest(prefixes: PrefixUsage[], max: number): PrefixUsage[] {
  if (prefixes.length <= max) {
    return prefixes.sort((a, b) => b.bytes - a.bytes);
  }
  const sorted = prefixes.sort((a, b) => b.bytes - a.bytes);
  const head = sorted.slice(0, max - 1);
  const tail = sorted.slice(max - 1);
  const other = tail.reduce(
    (acc, p) => ({ prefix: 'other', bytes: acc.bytes + p.bytes, count: acc.count + p.count }),
    { prefix: 'other', bytes: 0, count: 0 } as PrefixUsage,
  );
  return [...head, other];
}
