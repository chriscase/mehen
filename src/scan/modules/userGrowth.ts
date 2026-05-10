import type { ScanModule } from '../types.js';

/**
 * Flag a sudden spike in User row count. Calibrated for the
 * homestead-manager-style spam-tenant pattern that surfaced May 2026:
 * 58 bot accounts created over ~2 weeks via an open registration
 * endpoint. WARN at >10/day, ALERT at >25/day, CRITICAL at >100/day.
 *
 * Quietly skips databases without a "User" table (Postgres throws and
 * we catch + return empty).
 */
export const userGrowthScan: ScanModule = {
  name: 'user-growth',
  description: 'Flags unusual User-row growth in the last 24 hours',
  async run(query) {
    let rows: { count: string }[];
    try {
      rows = await query<{ count: string }>(
        'SELECT count(*)::text AS count FROM "User" WHERE "createdAt" > NOW() - INTERVAL \'1 day\'',
      );
    } catch {
      return [];
    }
    const created = Number(rows[0]?.count ?? 0);
    if (created < 10) return [];

    const severity =
      created > 100 ? 'critical' : created > 25 ? 'alert' : 'warn';

    return [
      {
        severity,
        title: `${created} new users in the last 24 hours`,
        description:
          `User table grew by ${created} rows in the last 24h. ` +
          `Spam-bot floods at this scale historically indicate an ` +
          `unguarded registration endpoint or compromised invite path.`,
        context: { count: created, window: '24h' },
      },
    ];
  },
};
