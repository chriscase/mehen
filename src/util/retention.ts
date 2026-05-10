import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface PruneOptions {
  dir: string;
  retainDays: number;
}

export interface PruneResult {
  scanned: number;
  removed: string[];
}

/**
 * Remove `.sql.gz` files in `dir` older than `retainDays`. Mirrors the
 * retention behavior of /srv/apps/backup-databases.sh that Mehen replaces.
 */
export async function pruneOldBackups(opts: PruneOptions): Promise<PruneResult> {
  const cutoff = Date.now() - opts.retainDays * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = await readdir(opts.dir);
  } catch {
    return { scanned: 0, removed: [] };
  }

  const removed: string[] = [];
  let scanned = 0;
  for (const name of entries) {
    if (!name.endsWith('.sql.gz')) continue;
    const full = join(opts.dir, name);
    let mtimeMs: number;
    try {
      const s = await stat(full);
      mtimeMs = s.mtimeMs;
    } catch {
      continue;
    }
    scanned++;
    if (mtimeMs < cutoff) {
      try {
        await unlink(full);
        removed.push(full);
      } catch {
        // Best-effort; missing/locked files surface in the next run.
      }
    }
  }
  return { scanned, removed };
}
