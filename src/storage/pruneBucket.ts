import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import type { Config } from '../config.js';

export interface PruneS3Options {
  config: Config;
  /** Off-site retention window in days. Objects older than this are deleted. */
  retainDays: number;
  /** When true, report what would be deleted without deleting anything. */
  dryRun?: boolean;
}

export interface PruneS3Result {
  /** Dated dump objects (under this host's prefix) examined. */
  scanned: number;
  /** Keys actually deleted (empty in dry-run). */
  deleted: string[];
  /** Keys that would be deleted (populated only in dry-run). */
  wouldDelete: string[];
}

/**
 * Parse the backup date (ms UTC) from a mehen dump key of the shape
 * `<host>/<db>/YYYY/MM/DD/dump.sql.gz`. Returns null for anything that isn't a
 * well-formed dated dump key — those are never eligible for deletion.
 */
export function backupKeyDate(key: string): number | null {
  const parts = key.split('/');
  if (parts.length < 6) return null;
  if (!parts[parts.length - 1].endsWith('dump.sql.gz')) return null;
  const y = parts[parts.length - 4];
  const m = parts[parts.length - 3];
  const d = parts[parts.length - 2];
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) return null;
  const ts = Date.UTC(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(ts) ? null : ts;
}

/**
 * Prune off-site backups from Linode Object Storage.
 *
 * The bucket is shared across hosts (osiris/*, isis/*), so this scopes to
 * THIS host's `<deployHost>/` prefix and only ever deletes well-formed dated
 * dump keys — any other object is ignored, so a malformed key or an unrelated
 * file can never be removed. Without this, every nightly run added a new
 * object that nothing ever deleted, so the bucket grew without bound and
 * tripped the DigitalEmpire "grew N% week-over-week" storage alert daily.
 */
export async function pruneS3Backups(opts: PruneS3Options): Promise<PruneS3Result> {
  const { config, retainDays, dryRun = false } = opts;
  if (retainDays <= 0) return { scanned: 0, deleted: [], wouldDelete: [] };
  if (
    !config.s3Endpoint ||
    !config.s3Region ||
    !config.s3Bucket ||
    !config.s3AccessKey ||
    !config.s3SecretKey
  ) {
    throw new Error('S3 not configured — cannot prune offsite backups');
  }

  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  const prefix = `${config.deployHost}/`;
  const bucket = config.s3Bucket;

  const client = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
    forcePathStyle: true,
  });

  let scanned = 0;
  const toDelete: string[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      const key = obj.Key ?? '';
      const keyDate = backupKeyDate(key);
      if (keyDate === null) continue; // not a dated mehen dump — never touch
      scanned++;
      if (keyDate < cutoff) toDelete.push(key);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  if (dryRun) return { scanned, deleted: [], wouldDelete: toDelete };

  const deleted: string[] = [];
  for (let i = 0; i < toDelete.length; i += 1000) {
    const batch = toDelete.slice(i, i + 1000);
    const res = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    const errored = new Set((res.Errors ?? []).map((e) => e.Key));
    for (const key of batch) if (!errored.has(key)) deleted.push(key);
  }

  return { scanned, deleted, wouldDelete: [] };
}

// Re-export for tests that verify command construction at the boundary.
export { S3Client, ListObjectsV2Command, DeleteObjectsCommand };
