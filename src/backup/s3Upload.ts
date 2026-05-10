import { createReadStream } from 'node:fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Config } from '../config.js';

export interface UploadParams {
  config: Config;
  /** Local file path to upload. */
  filePath: string;
  /** S3 object key (e.g. "isis/homestead_production/2026/05/10/dump.sql.gz") */
  objectKey: string;
}

/**
 * Upload a local backup file to Linode Object Storage (S3-compatible).
 * Returns the canonical s3:// URL for storage in BackupRun.offsiteUrl.
 *
 * Uses lib-storage's multipart Upload so >5MB files stream in chunks.
 */
export async function uploadToS3(params: UploadParams): Promise<{ url: string; etag?: string }> {
  const { config, filePath, objectKey } = params;
  if (
    !config.s3Endpoint ||
    !config.s3Region ||
    !config.s3Bucket ||
    !config.s3AccessKey ||
    !config.s3SecretKey
  ) {
    throw new Error('S3 config incomplete — cannot upload offsite');
  }

  const client = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    credentials: {
      accessKeyId: config.s3AccessKey,
      secretAccessKey: config.s3SecretKey,
    },
    forcePathStyle: false,
  });

  const upload = new Upload({
    client,
    params: {
      Bucket: config.s3Bucket,
      Key: objectKey,
      Body: createReadStream(filePath),
      ContentType: 'application/gzip',
    },
  });

  const result = await upload.done();
  return {
    url: `s3://${config.s3Bucket}/${objectKey}`,
    etag: 'ETag' in result ? (result.ETag as string | undefined) : undefined,
  };
}

// Re-export for tests that want to verify command construction without
// actually hitting Linode. Vitest can mock at the boundary.
export { S3Client, PutObjectCommand };
