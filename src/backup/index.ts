import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { isOffsiteEnabled } from '../config.js';
import { runPgDump } from './pgDump.js';
import { uploadToS3 } from './s3Upload.js';
import { postBackupRun, type BackupRunReport } from '../report.js';
import { pruneOldBackups } from '../util/retention.js';
import { pruneS3Backups } from '../storage/pruneBucket.js';
import { log } from '../util/log.js';

export interface RunBackupsOptions {
  config: Config;
  /** Restrict to a subset of configured DBs. Empty = all. */
  databases?: string[];
  /** When true, skip pg_dump + upload + report; just print plan. */
  dryRun?: boolean;
}

export interface RunBackupsResult {
  totalDbs: number;
  successCount: number;
  partialCount: number;
  failedCount: number;
  pruned: string[];
  /** Off-site (S3) dump keys pruned (or, in dry-run, that would be pruned). */
  s3Pruned: string[];
}

function dateStamp(d: Date): { date: string; year: string; month: string; day: string } {
  const year = String(d.getUTCFullYear());
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return { date: `${year}${month}${day}`, year, month, day };
}

/**
 * Orchestrates a full nightly run:
 *   1. pg_dump each configured DB to /<backupDir>/<db>_<YYYYMMDD>.sql.gz
 *   2. Upload each to s3://<bucket>/<host>/<db>/<YYYY>/<MM>/<DD>/dump.sql.gz
 *   3. POST a BackupRun summary to the DE control plane
 *   4. Prune local backups older than `backupRetainDays`
 *
 * Each DB is independent — a failure on one doesn't abort the rest.
 * Returns aggregate counts so the CLI can pick an exit code.
 */
export async function runBackups(opts: RunBackupsOptions): Promise<RunBackupsResult> {
  const { config, databases, dryRun = false } = opts;
  const targetDbs = databases?.length ? databases : config.backupDbs;

  if (targetDbs.length === 0) {
    log.warn('No backup databases configured', { config: config.deployHost });
    return { totalDbs: 0, successCount: 0, partialCount: 0, failedCount: 0, pruned: [], s3Pruned: [] };
  }

  if (!dryRun) {
    await mkdir(config.backupDir, { recursive: true });
  }

  const offsite = isOffsiteEnabled(config);
  log.info('Mehen backup run starting', {
    deployHost: config.deployHost,
    databases: targetDbs,
    offsite,
    dryRun,
  });

  let successCount = 0;
  let partialCount = 0;
  let failedCount = 0;

  for (const database of targetDbs) {
    const startedAt = new Date();
    const stamp = dateStamp(startedAt);
    const outputPath = join(config.backupDir, `${database}_${stamp.date}.sql.gz`);
    const objectKey = `${config.deployHost}/${database}/${stamp.year}/${stamp.month}/${stamp.day}/dump.sql.gz`;

    if (dryRun) {
      log.info('[dry-run] would back up', { database, outputPath, objectKey });
      successCount++;
      continue;
    }

    let status: BackupRunReport['status'] = 'failed';
    let sizeBytes: number | null = null;
    let durationMs: number | null = null;
    let localPath: string | null = null;
    let offsiteUrl: string | null = null;
    let errorMessage: string | null = null;

    try {
      const dump = await runPgDump({
        database,
        outputPath,
        pgUser: config.pgUser,
        useSudo: config.pgUseSudo,
      });
      localPath = dump.outputPath;
      sizeBytes = dump.sizeBytes;
      durationMs = dump.durationMs;
      log.info('pg_dump complete', { database, outputPath, sizeBytes, durationMs });

      if (offsite) {
        try {
          const upload = await uploadToS3({ config, filePath: outputPath, objectKey });
          offsiteUrl = upload.url;
          status = 'success';
          log.info('offsite upload complete', { database, offsiteUrl });
        } catch (uploadErr) {
          status = 'partial';
          errorMessage = `Offsite upload failed: ${(uploadErr as Error).message}`;
          log.warn('offsite upload failed (local backup retained)', {
            database,
            error: errorMessage,
          });
        }
      } else {
        status = 'success';
      }
    } catch (err) {
      status = 'failed';
      errorMessage = (err as Error).message;
      log.error('pg_dump failed', { database, error: errorMessage });
    }

    if (status === 'success') successCount++;
    else if (status === 'partial') partialCount++;
    else failedCount++;

    const finishedAt = new Date();
    const report: BackupRunReport = {
      entityId: config.entityId,
      database,
      status,
      sizeBytes,
      durationMs: durationMs ?? Date.now() - startedAt.getTime(),
      localPath,
      offsiteUrl,
      errorMessage,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    };

    try {
      await postBackupRun(config, report);
      log.info('reported run', { database, status });
    } catch (reportErr) {
      log.error('failed to report run (will be retried by next cron)', {
        database,
        error: (reportErr as Error).message,
      });
    }
  }

  const pruned = dryRun
    ? { scanned: 0, removed: [] }
    : await pruneOldBackups({
        dir: config.backupDir,
        retainDays: config.backupRetainDays,
      });

  // Prune off-site dumps too. Without this the shared bucket grows forever
  // (the dump key is dated, never overwritten), which is what trips the DE
  // storage-growth alert. Dry-run reports the would-delete set. Best-effort:
  // a prune failure never fails the backup run.
  let s3Pruned: string[] = [];
  if (offsite && config.s3RetainDays > 0) {
    try {
      const result = await pruneS3Backups({
        config,
        retainDays: config.s3RetainDays,
        dryRun,
      });
      s3Pruned = dryRun ? result.wouldDelete : result.deleted;
      log.info(dryRun ? '[dry-run] offsite prune plan' : 'offsite prune complete', {
        scanned: result.scanned,
        pruned: s3Pruned.length,
        retainDays: config.s3RetainDays,
      });
    } catch (err) {
      log.warn('offsite prune failed (backups retained)', { error: (err as Error).message });
    }
  }

  log.info('Mehen backup run complete', {
    totalDbs: targetDbs.length,
    successCount,
    partialCount,
    failedCount,
    pruned: pruned.removed.length,
    s3Pruned: s3Pruned.length,
  });

  return {
    totalDbs: targetDbs.length,
    successCount,
    partialCount,
    failedCount,
    pruned: pruned.removed,
    s3Pruned,
  };
}
