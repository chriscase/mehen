import type { Config } from '../config.js';
import { signRequest } from '../auth.js';
import { log } from '../util/log.js';
import { scanBucket, type BucketScanResult } from './listBucket.js';

export interface RunStorageScanOptions {
  config: Config;
  /** Print plan + result without POSTing back to DE. */
  dryRun?: boolean;
}

export interface RunStorageScanResult {
  scanned: BucketScanResult | null;
  reported: boolean;
  errors: string[];
}

/**
 * One-shot bucket scan + report. Designed for cron:
 *   - exits 0 on success (with or without offsite enabled)
 *   - exits 1 if S3 isn't configured
 *   - exits 2 if the scan succeeded but reporting back to DE failed (the
 *     bucket is fine but the dashboard won't update — next run will retry)
 */
export async function runStorageScan(opts: RunStorageScanOptions): Promise<RunStorageScanResult> {
  const { config, dryRun = false } = opts;
  const errors: string[] = [];

  if (
    !config.s3Endpoint ||
    !config.s3Region ||
    !config.s3Bucket ||
    !config.s3AccessKey ||
    !config.s3SecretKey
  ) {
    log.warn('S3 not configured — skipping storage scan', { deployHost: config.deployHost });
    return { scanned: null, reported: false, errors: ['S3 not configured'] };
  }

  log.info('Mehen storage scan starting', {
    deployHost: config.deployHost,
    bucket: config.s3Bucket,
    endpoint: config.s3Endpoint,
    dryRun,
  });

  let scan: BucketScanResult;
  try {
    scan = await scanBucket(config);
  } catch (err) {
    const msg = `Bucket scan failed: ${(err as Error).message}`;
    log.error(msg, { bucket: config.s3Bucket });
    return { scanned: null, reported: false, errors: [msg] };
  }

  log.info('Bucket scanned', {
    bucket: scan.bucket,
    totalBytes: scan.totalBytes,
    objectCount: scan.objectCount,
    prefixCount: scan.prefixes.length,
  });

  if (dryRun) {
    log.info('[dry-run] would POST storage sample', { entityId: config.entityId });
    return { scanned: scan, reported: false, errors };
  }

  try {
    await postStorageSample(config, scan);
    log.info('Storage sample reported', { entityId: config.entityId, bucket: scan.bucket });
    return { scanned: scan, reported: true, errors };
  } catch (err) {
    const msg = `Storage sample report failed: ${(err as Error).message}`;
    log.error(msg);
    return { scanned: scan, reported: false, errors: [msg] };
  }
}

interface StorageSamplePayload {
  entityId: string;
  bucket: string;
  endpoint: string;
  totalBytes: number;
  objectCount: number;
  prefixes: Array<{ prefix: string; bytes: number; count: number }>;
  sampledAt: string;
}

async function postStorageSample(config: Config, scan: BucketScanResult): Promise<void> {
  const url = `${config.backendUrl.replace(/\/$/, '')}/api/agent/storage-sample`;
  const payload: StorageSamplePayload = {
    entityId: config.entityId,
    bucket: scan.bucket,
    endpoint: scan.endpoint,
    totalBytes: scan.totalBytes,
    objectCount: scan.objectCount,
    prefixes: scan.prefixes,
    sampledAt: new Date().toISOString(),
  };
  const body = JSON.stringify(payload);
  const headers = signRequest(config.agentKeyId, config.agentKeyHash, body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${url} → ${res.status}: ${text.slice(0, 300)}`);
  }
}
