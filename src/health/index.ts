import type { Config } from '../config.js';
import { log } from '../util/log.js';

/**
 * Health-check probe. Hits a list of configured /api/health URLs (one
 * per app on this host) and reports up/down state. Reporting endpoint
 * lands with DE follow-up — for now this just prints to logs so cron
 * output picks it up.
 *
 * Configure via MEHEN_HEALTH_URLS (comma-separated absolute URLs).
 */
export interface HealthSample {
  url: string;
  ok: boolean;
  statusCode: number | null;
  durationMs: number;
  error?: string;
}

export async function runHealthChecks(opts: {
  config: Config;
  urls?: string[];
}): Promise<HealthSample[]> {
  const targets = (opts.urls && opts.urls.length > 0
    ? opts.urls
    : (process.env.MEHEN_HEALTH_URLS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean));

  if (targets.length === 0) {
    log.warn('No health URLs configured', {
      hint: 'Set MEHEN_HEALTH_URLS=https://app1/api/health,https://app2/api/health',
    });
    return [];
  }

  log.info('Mehen health probe starting', { count: targets.length, deployHost: opts.config.deployHost });

  const samples: HealthSample[] = [];
  for (const url of targets) {
    const startedAt = Date.now();
    try {
      const res = await fetch(url, { method: 'GET' });
      const sample: HealthSample = {
        url,
        ok: res.ok,
        statusCode: res.status,
        durationMs: Date.now() - startedAt,
      };
      samples.push(sample);
      if (res.ok) {
        log.info('health ok', { ...sample });
      } else {
        log.warn('health degraded', { ...sample });
      }
    } catch (err) {
      const sample: HealthSample = {
        url,
        ok: false,
        statusCode: null,
        durationMs: Date.now() - startedAt,
        error: (err as Error).message,
      };
      samples.push(sample);
      log.warn('health unreachable', { ...sample });
    }
  }

  return samples;
}
