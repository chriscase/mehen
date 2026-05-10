import type { ScanModule } from '../types.js';

/**
 * Stale unverified accounts. Accounts that signed up but never clicked
 * the verification email after 7 days are dead weight; large counts can
 * indicate ongoing spam or an email-deliverability problem.
 */
export const unverifiedAccountsScan: ScanModule = {
  name: 'unverified-accounts',
  description: 'Flags large counts of accounts unverified for >7 days',
  async run(query) {
    let rows: { count: string }[];
    try {
      rows = await query<{ count: string }>(
        'SELECT count(*)::text AS count FROM "User" WHERE "emailVerified" IS NULL AND "createdAt" < NOW() - INTERVAL \'7 days\'',
      );
    } catch {
      return [];
    }
    const stale = Number(rows[0]?.count ?? 0);
    if (stale < 5) return [];

    return [
      {
        severity: stale > 50 ? 'alert' : 'info',
        title: `${stale} accounts unverified for >7 days`,
        description:
          `${stale} User rows have createdAt older than 7 days but ` +
          `emailVerified IS NULL. Could be ordinary churn, but high ` +
          `counts often reflect either a deliverability issue or a ` +
          `bot wave that didn't bother to verify.`,
        context: { count: stale, window: '>7d unverified' },
      },
    ];
  },
};
