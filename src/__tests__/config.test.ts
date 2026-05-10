import { describe, it, expect } from 'vitest';
import { loadConfigFromEnv, hashSecret, isOffsiteEnabled, maskConfig } from '../config.js';

const REQUIRED: NodeJS.ProcessEnv = {
  MEHEN_BACKEND_URL: 'https://mehen.example.com',
  MEHEN_AGENT_KEY_ID: 'agk_test',
  MEHEN_AGENT_KEY_HASH: 'f'.repeat(64),
  MEHEN_ENTITY_ID: 'srv-test',
  MEHEN_DEPLOY_HOST: 'osiris',
  MEHEN_BACKUP_DBS: 'foo,bar',
};

describe('loadConfigFromEnv', () => {
  it('parses the minimal required env', () => {
    const config = loadConfigFromEnv(REQUIRED);
    expect(config.backendUrl).toBe('https://mehen.example.com');
    expect(config.agentKeyId).toBe('agk_test');
    expect(config.entityId).toBe('srv-test');
    expect(config.backupDbs).toEqual(['foo', 'bar']);
  });

  it('throws on missing backendUrl', () => {
    const env = { ...REQUIRED } as NodeJS.ProcessEnv;
    delete env.MEHEN_BACKEND_URL;
    expect(() => loadConfigFromEnv(env)).toThrow();
  });

  it('throws on bad backendUrl', () => {
    expect(() => loadConfigFromEnv({ ...REQUIRED, MEHEN_BACKEND_URL: 'not-a-url' })).toThrow();
  });

  it('throws on too-short keyHash', () => {
    expect(() =>
      loadConfigFromEnv({ ...REQUIRED, MEHEN_AGENT_KEY_HASH: 'short' }),
    ).toThrow();
  });

  it('hashes MEHEN_AGENT_KEY_SECRET when KEY_HASH is absent', () => {
    const env = { ...REQUIRED } as NodeJS.ProcessEnv;
    delete env.MEHEN_AGENT_KEY_HASH;
    env.MEHEN_AGENT_KEY_SECRET = 'super-secret-value';
    const config = loadConfigFromEnv(env);
    expect(config.agentKeyHash).toBe(hashSecret('super-secret-value'));
  });

  it('parses backup retention', () => {
    const config = loadConfigFromEnv({ ...REQUIRED, MEHEN_BACKUP_RETAIN_DAYS: '14' });
    expect(config.backupRetainDays).toBe(14);
  });

  it('defaults backupDir + backupRetainDays', () => {
    const config = loadConfigFromEnv(REQUIRED);
    expect(config.backupDir).toBe('/srv/apps/backups');
    expect(config.backupRetainDays).toBe(7);
  });

  it('parses comma-separated backupDbs and trims whitespace', () => {
    const config = loadConfigFromEnv({
      ...REQUIRED,
      MEHEN_BACKUP_DBS: 'a, b ,c, ',
    });
    expect(config.backupDbs).toEqual(['a', 'b', 'c']);
  });
});

describe('isOffsiteEnabled', () => {
  it('returns true when all 5 S3 fields are set', () => {
    const config = loadConfigFromEnv({
      ...REQUIRED,
      MEHEN_S3_ENDPOINT: 'https://s3.example',
      MEHEN_S3_REGION: 'us-iad-1',
      MEHEN_S3_BUCKET: 'b',
      MEHEN_S3_ACCESS_KEY: 'k',
      MEHEN_S3_SECRET_KEY: 's',
    });
    expect(isOffsiteEnabled(config)).toBe(true);
  });

  it('returns false when any field is missing', () => {
    const config = loadConfigFromEnv({
      ...REQUIRED,
      MEHEN_S3_ENDPOINT: 'https://s3.example',
      MEHEN_S3_REGION: 'us-iad-1',
      MEHEN_S3_BUCKET: 'b',
      MEHEN_S3_ACCESS_KEY: 'k',
      // no secret
    });
    expect(isOffsiteEnabled(config)).toBe(false);
  });
});

describe('maskConfig', () => {
  it('masks agentKeyHash and s3SecretKey', () => {
    const config = loadConfigFromEnv({
      ...REQUIRED,
      MEHEN_S3_SECRET_KEY: 'top-secret',
    });
    const masked = maskConfig(config);
    expect(masked.agentKeyHash).toBe('ffffffff…');
    expect(masked.s3SecretKey).toBe('***');
  });
});
