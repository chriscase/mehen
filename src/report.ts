import { signRequest } from './auth.js';
import { log } from './util/log.js';
import type { Config } from './config.js';

export interface BackupRunReport {
  entityId: string;
  database: string;
  status: 'success' | 'partial' | 'failed';
  sizeBytes?: number | null;
  durationMs?: number | null;
  localPath?: string | null;
  offsiteUrl?: string | null;
  errorMessage?: string | null;
  startedAt: string;
  finishedAt: string;
}

/**
 * POST a backup run summary to the DE control plane. Throws on failure
 * so the caller can decide whether to retry or surface the error.
 */
export async function postBackupRun(
  config: Config,
  report: BackupRunReport,
): Promise<{ runId: string }> {
  const url = `${config.backendUrl.replace(/\/$/, '')}/api/agent/backup-run`;
  const body = JSON.stringify(report);
  const headers = signRequest(config.agentKeyId, config.agentKeyHash, body);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.error('Backup run report failed', {
      url,
      status: res.status,
      response: text.slice(0, 500),
    });
    throw new Error(`POST ${url} → ${res.status}`);
  }

  const json = (await res.json()) as { runId: string };
  return json;
}
