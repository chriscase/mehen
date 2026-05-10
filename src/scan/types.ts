/**
 * Shape that a scan module emits per finding. The agent collects these
 * and POSTs the batch to /api/agent/scan-run on the DE control plane.
 */
export interface ScanFindingDraft {
  severity: 'info' | 'warn' | 'alert' | 'critical';
  title: string;
  description: string;
  context?: Record<string, unknown>;
}

export interface ScanContext {
  /** Database name being scanned. */
  database: string;
  /** UTC time the run was kicked off (used to dedupe daily). */
  detectedAt: Date;
}

/**
 * A scan module is a function that returns findings for one (database,
 * scanModule) tuple. The agent is responsible for connection management
 * and posting results — modules are pure(-ish) data extractors.
 */
export interface ScanModule {
  /** Stable identifier — included in every finding's scanModule field. */
  name: string;
  /** Short human description — printed in `mehen scan --list`. */
  description: string;
  /** Run the scan and return any findings. */
  run(query: QueryFn, ctx: ScanContext): Promise<ScanFindingDraft[]>;
}

/**
 * Minimal query interface so modules don't depend on a specific Postgres
 * client. The agent injects a real implementation; tests can pass a mock.
 */
export type QueryFn = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
