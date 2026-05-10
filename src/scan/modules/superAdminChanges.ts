import type { ScanModule } from '../types.js';

/**
 * Surface any SuperAdminGrant create/revoke in the last 24h. Any change
 * to platform-level admin authority is worth a WARN-level finding —
 * either expected (a known admin rotation) and quickly acknowledged, or
 * unexpected (a sign of compromise).
 *
 * Targets the homestead-manager-style schema (`SuperAdminGrant` table
 * with `grantedAt` / `revokedAt`). Skips databases without it.
 */
export const superAdminChangesScan: ScanModule = {
  name: 'super-admin-changes',
  description: 'Flags any SuperAdminGrant create/revoke in the last 24 hours',
  async run(query) {
    let granted: { count: string }[];
    let revoked: { count: string }[];
    try {
      [granted, revoked] = await Promise.all([
        query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "SuperAdminGrant" WHERE "grantedAt" > NOW() - INTERVAL \'1 day\'',
        ),
        query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "SuperAdminGrant" WHERE "revokedAt" IS NOT NULL AND "revokedAt" > NOW() - INTERVAL \'1 day\'',
        ),
      ]);
    } catch {
      return [];
    }
    const grantedCount = Number(granted[0]?.count ?? 0);
    const revokedCount = Number(revoked[0]?.count ?? 0);
    if (grantedCount === 0 && revokedCount === 0) return [];

    return [
      {
        severity: 'warn',
        title: `Super-admin grants changed (${grantedCount} granted, ${revokedCount} revoked)`,
        description:
          `In the last 24 hours, ${grantedCount} SuperAdminGrant rows were ` +
          `created and ${revokedCount} were revoked. Verify each change ` +
          `was an intended admin rotation; investigate immediately if not.`,
        context: { granted: grantedCount, revoked: revokedCount, window: '24h' },
      },
    ];
  },
};
