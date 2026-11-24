import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config as dotenv } from 'dotenv';

/**
 * Mehen agent config. Loaded from `/etc/abydos-ops.env` by default
 * (root-owned, mode 600); the path is overridable for tests.
 */
const BaseConfigSchema = z.object({
  /** Where to POST run summaries. e.g. https://mehen.abydonian.com */
  backendUrl: z.string().url(),
  /** Public agent key id (matches AgentToken.keyId in DE). */
  agentKeyId: z.string().min(1),
  /**
   * v2 (recommended): path to this host's Ed25519 private key (PKCS#8 PEM,
   * mode 600). DE stores only the public key. Create with `mehen keygen`.
   */
  agentKeyFile: z.string().min(1).optional(),
  /** v1 (legacy): SHA-256 hash of the agent's keySecret, used as HMAC key. */
  agentKeyHash: z.string().length(64, 'Expected 64-hex SHA-256 hash').optional(),
  /** Entity row id this server is registered as in DE. */
  entityId: z.string().min(1),
  /** Friendly identifier for logs ("isis", "osiris"). */
  deployHost: z.string().min(1),

  /** Comma-separated DB names to back up nightly. */
  backupDbs: z.array(z.string().min(1)),
  /** Local backup directory. */
  backupDir: z.string().default('/srv/apps/backups'),
  /** Days of local backups to retain (older auto-pruned). */
  backupRetainDays: z.coerce.number().int().positive().default(7),
  /**
   * Days of OFF-SITE (S3) backups to retain. Independent of the local window
   * — offsite dumps are usually kept longer. Older dated dump objects under
   * this host's prefix are pruned after each run. 0 disables S3 pruning.
   */
  s3RetainDays: z.coerce.number().int().nonnegative().default(30),
  /** Postgres role used for pg_dump. Falls back to peer auth via sudo. */
  pgUser: z.string().optional(),
  /**
   * When true, run pg_dump via `sudo -u <pgUser> pg_dump`. Use when
   * the cron OS user differs from the postgres role (e.g. running as
   * copilot but pg_dump must auth as postgres).
   */
  pgUseSudo: z.boolean().default(false),

  /** Linode Object Storage settings. Off-site upload is skipped if absent. */
  s3Endpoint: z.string().url().optional(),
  s3Region: z.string().optional(),
  s3Bucket: z.string().optional(),
  s3AccessKey: z.string().optional(),
  s3SecretKey: z.string().optional(),
});

const ConfigSchema = BaseConfigSchema.refine((c) => Boolean(c.agentKeyFile) !== Boolean(c.agentKeyHash), {
  message: 'Set exactly one agent credential: MEHEN_AGENT_KEY_FILE (v2) or MEHEN_AGENT_KEY_HASH / MEHEN_AGENT_KEY_SECRET (v1)',
  path: ['agentKeyFile'],
});

export type Config = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG_PATH = '/etc/abydos-ops.env';

interface LoadOptions {
  /** Override the config file path. Tests pass this. */
  path?: string;
  /** Override env source (defaults to process.env after dotenv is applied). */
  env?: NodeJS.ProcessEnv;
}

function parseList(v: string | undefined): string[] {
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Compute the SHA-256 hash of a raw key secret. The agent stores either:
 *  - MEHEN_AGENT_KEY_HASH directly (preferred — never has the plaintext secret on disk)
 *  - MEHEN_AGENT_KEY_SECRET, hashed at load time (fallback for first-run bootstrap)
 */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function loadConfig(opts: LoadOptions = {}): Config {
  const path = opts.path ?? DEFAULT_CONFIG_PATH;
  if (existsSync(path)) {
    dotenv({ path, override: false });
  }

  const env = opts.env ?? process.env;

  // Resolve agent key hash: prefer MEHEN_AGENT_KEY_HASH; fall back to
  // hashing MEHEN_AGENT_KEY_SECRET. Allows server-side rotation tools
  // to issue raw secrets and the agent to record the hash on first run.
  // v2 (MEHEN_AGENT_KEY_FILE) wins; the v1 hash is only derived when no key file is set.
  const agentKeyFile = env.MEHEN_AGENT_KEY_FILE || undefined;
  let agentKeyHash: string | undefined = agentKeyFile ? undefined : env.MEHEN_AGENT_KEY_HASH || undefined;
  if (!agentKeyFile && !agentKeyHash && env.MEHEN_AGENT_KEY_SECRET) {
    agentKeyHash = hashSecret(env.MEHEN_AGENT_KEY_SECRET);
  }

  return ConfigSchema.parse({
    backendUrl: env.MEHEN_BACKEND_URL,
    agentKeyId: env.MEHEN_AGENT_KEY_ID,
    agentKeyFile,
    agentKeyHash,
    entityId: env.MEHEN_ENTITY_ID,
    deployHost: env.MEHEN_DEPLOY_HOST,
    backupDbs: parseList(env.MEHEN_BACKUP_DBS),
    backupDir: env.MEHEN_BACKUP_DIR ?? '/srv/apps/backups',
    backupRetainDays: env.MEHEN_BACKUP_RETAIN_DAYS ?? 7,
    s3RetainDays: env.MEHEN_S3_RETAIN_DAYS ?? 30,
    pgUser: env.MEHEN_PG_USER || undefined,
    pgUseSudo: /^(1|true|yes|on)$/i.test(env.MEHEN_PG_USE_SUDO ?? ''),
    s3Endpoint: env.MEHEN_S3_ENDPOINT || undefined,
    s3Region: env.MEHEN_S3_REGION || undefined,
    s3Bucket: env.MEHEN_S3_BUCKET || undefined,
    s3AccessKey: env.MEHEN_S3_ACCESS_KEY || undefined,
    s3SecretKey: env.MEHEN_S3_SECRET_KEY || undefined,
  });
}

/**
 * Returns true if all S3 settings are present and the agent should attempt
 * off-site upload. Local-only mode is the fallback when S3 isn't configured.
 */
export function isOffsiteEnabled(config: Config): boolean {
  return Boolean(
    config.s3Endpoint && config.s3Region && config.s3Bucket && config.s3AccessKey && config.s3SecretKey,
  );
}

/** Mask sensitive fields for safe printing in `mehen config`. */
export function maskConfig(config: Config): Record<string, unknown> {
  return {
    ...config,
    agentKeyHash: config.agentKeyHash ? `${config.agentKeyHash.slice(0, 8)}…` : undefined,
    signatureVersion: config.agentKeyFile ? 2 : 1,
    s3SecretKey: config.s3SecretKey ? '***' : undefined,
  };
}

export { hashSecret, DEFAULT_CONFIG_PATH };

// Tests load this without going through the file path.
export function loadConfigFromEnv(env: NodeJS.ProcessEnv): Config {
  return loadConfig({ path: '/__mehen_no_file__', env });
}
