import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

export interface PgDumpOptions {
  database: string;
  outputPath: string;
  /** Postgres role for the dump. If omitted, pg_dump runs without -U. */
  pgUser?: string;
  /**
   * When true, run via `sudo -u <pgUser> pg_dump`. Useful when the
   * cron environment runs as one OS user but peer auth requires another
   * (e.g. running as `copilot` but only `postgres` has pg_read_all_data
   * grants on the target DBs).
   */
  useSudo?: boolean;
}

export interface PgDumpResult {
  outputPath: string;
  sizeBytes: number;
  durationMs: number;
}

/**
 * Run `pg_dump <db> | gzip > <outputPath>`. Streams to disk so large
 * databases don't buffer in memory.
 *
 * Throws on non-zero exit from pg_dump. The caller is responsible for
 * cleanup (the partial file is left on disk for diagnosis).
 */
export async function runPgDump(opts: PgDumpOptions): Promise<PgDumpResult> {
  const startedAt = Date.now();

  let command: string;
  let args: string[];
  if (opts.useSudo) {
    if (!opts.pgUser) {
      throw new Error('useSudo requires pgUser');
    }
    command = 'sudo';
    args = ['-n', '-u', opts.pgUser, 'pg_dump', opts.database];
  } else {
    command = 'pg_dump';
    args = [];
    if (opts.pgUser) args.push('-U', opts.pgUser);
    args.push(opts.database);
  }

  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const writeStream = createWriteStream(opts.outputPath);
  const gzip = createGzip({ level: 6 });

  // Drive the pg_dump stdout → gzip → file pipeline.
  const pipelinePromise = pipeline(child.stdout!, gzip, writeStream);
  const exitPromise = new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? -1));
  });

  await Promise.all([pipelinePromise, exitPromise]).catch((err) => {
    throw new Error(`pg_dump pipeline failed for ${opts.database}: ${err.message ?? err}`);
  });

  const exitCode = await exitPromise;
  if (exitCode !== 0) {
    throw new Error(
      `pg_dump exited ${exitCode} for ${opts.database}: ${stderr.trim().slice(0, 500)}`,
    );
  }

  const stats = await stat(opts.outputPath);
  return {
    outputPath: opts.outputPath,
    sizeBytes: stats.size,
    durationMs: Date.now() - startedAt,
  };
}
