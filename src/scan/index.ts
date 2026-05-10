import { Client } from 'pg';
import type { Config } from '../config.js';
import { signRequest } from '../auth.js';
import { log } from '../util/log.js';
import type { ScanModule, ScanFindingDraft, QueryFn } from './types.js';
import { userGrowthScan } from './modules/userGrowth.js';
import { superAdminChangesScan } from './modules/superAdminChanges.js';
import { unverifiedAccountsScan } from './modules/unverifiedAccounts.js';

/**
 * Bundled scan module registry. Future modules drop in here.
 */
const REGISTRY: ScanModule[] = [
  userGrowthScan,
  superAdminChangesScan,
  unverifiedAccountsScan,
];

export function listAvailableModules(): { name: string; description: string }[] {
  return REGISTRY.map((m) => ({ name: m.name, description: m.description }));
}

export interface RunScansOptions {
  config: Config;
  /** Restrict scans to a subset of configured DBs. Empty = all. */
  databases?: string[];
  /** Restrict to a subset of module names. Empty = all. */
  modules?: string[];
  /** Print plan without connecting to DBs. */
  dryRun?: boolean;
}

export interface RunScansResult {
  totalScans: number;
  totalFindings: number;
  errors: string[];
}

/**
 * Run all registered scan modules across all configured target DBs.
 * Each (database, module) pair is a single scan run; findings batch
 * to /api/agent/scan-run by (database, module). Errors on one
 * module/database pair don't abort the rest.
 */
export async function runScans(opts: RunScansOptions): Promise<RunScansResult> {
  const { config, dryRun = false } = opts;
  const targetDbs = opts.databases?.length ? opts.databases : config.backupDbs;
  const targetModules = opts.modules?.length
    ? REGISTRY.filter((m) => opts.modules!.includes(m.name))
    : REGISTRY;

  if (targetDbs.length === 0) {
    log.warn('No databases configured for scan', { deployHost: config.deployHost });
    return { totalScans: 0, totalFindings: 0, errors: [] };
  }

  log.info('Mehen scan run starting', {
    deployHost: config.deployHost,
    databases: targetDbs,
    modules: targetModules.map((m) => m.name),
    dryRun,
  });

  let totalScans = 0;
  let totalFindings = 0;
  const errors: string[] = [];

  for (const database of targetDbs) {
    if (dryRun) {
      log.info('[dry-run] would scan', { database, modules: targetModules.map((m) => m.name) });
      continue;
    }

    let client: Client | null = null;
    try {
      // Local connection. Trusts pg_hba peer auth on the same host;
      // pgUser falls back to the OS user (typically `copilot`).
      client = new Client({
        host: 'localhost',
        database,
        user: config.pgUser,
        // No password — peer auth on the local socket.
      });
      await client.connect();
    } catch (err) {
      const msg = `Connect to ${database} failed: ${(err as Error).message}`;
      log.warn('connect failed', { database, error: msg });
      errors.push(msg);
      continue;
    }

    const query: QueryFn = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const result = await client!.query(sql, params);
      return result.rows as T[];
    };

    for (const mod of targetModules) {
      const detectedAt = new Date();
      let findings: ScanFindingDraft[];
      try {
        findings = await mod.run(query, { database, detectedAt });
      } catch (err) {
        const msg = `Scan ${mod.name} on ${database} failed: ${(err as Error).message}`;
        log.warn('scan module failed', { database, module: mod.name, error: msg });
        errors.push(msg);
        continue;
      }
      totalScans++;
      totalFindings += findings.length;

      if (findings.length === 0) {
        log.debug('no findings', { database, module: mod.name });
        continue;
      }

      try {
        await postScanRun(config, {
          entityId: config.entityId,
          scanModule: mod.name,
          detectedAt: detectedAt.toISOString(),
          findings,
        });
        log.info('scan reported', { database, module: mod.name, findingCount: findings.length });
      } catch (err) {
        const msg = `Report ${mod.name} on ${database} failed: ${(err as Error).message}`;
        log.warn('scan report failed (will retry next run)', {
          database,
          module: mod.name,
          error: msg,
        });
        errors.push(msg);
      }
    }

    await client.end().catch(() => {});
  }

  log.info('Mehen scan run complete', {
    totalScans,
    totalFindings,
    errorCount: errors.length,
  });
  return { totalScans, totalFindings, errors };
}

interface ScanRunPayload {
  entityId: string;
  scanModule: string;
  detectedAt: string;
  findings: ScanFindingDraft[];
}

async function postScanRun(config: Config, payload: ScanRunPayload): Promise<void> {
  const url = `${config.backendUrl.replace(/\/$/, '')}/api/agent/scan-run`;
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
