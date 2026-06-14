import { Client } from 'minio';
import { MinioConfig } from '../config';

export function createMinioClient(config: MinioConfig) {
  return new Client({
    endPoint: config.endpoint.split(':')[0],
    port: Number(config.endpoint.split(':')[1] || '9000'),
    useSSL: false,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  });
}

async function ensureBucket(client: ReturnType<typeof createMinioClient>, config: MinioConfig): Promise<void> {
  const exists = await client.bucketExists(config.bucket);
  if (!exists) {
    await client.makeBucket(config.bucket, config.region);
  }
}

export async function verifyStorage(client: ReturnType<typeof createMinioClient>, config: MinioConfig) {
  try {
    await ensureBucket(client, config);

    await client.putObject(config.bucket, 'health-check.txt', 'ok');
    const stream = await client.getObject(config.bucket, 'health-check.txt');

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString('utf-8');
  } catch (error) {
    throw new Error(`MinIO health check failed: ${error}`);
  }
}

export interface SnapshotInfo {
  key: string;
  size: number;
  lastModified: string;
}

/** Sube `data` como JSON al bucket configurado, bajo la key indicada (p.ej. `ingest/2026-06-14T03-15-00-000Z.json`). */
export async function putJsonSnapshot(
  client: ReturnType<typeof createMinioClient>,
  config: MinioConfig,
  key: string,
  data: unknown
): Promise<SnapshotInfo> {
  await ensureBucket(client, config);

  const body = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
  await client.putObject(config.bucket, key, body, body.length, { 'Content-Type': 'application/json' });

  return { key, size: body.length, lastModified: new Date().toISOString() };
}

/** Lista los snapshots guardados bajo `prefix`, ordenados por fecha de modificación descendente. */
export async function listSnapshots(
  client: ReturnType<typeof createMinioClient>,
  config: MinioConfig,
  prefix: string
): Promise<SnapshotInfo[]> {
  await ensureBucket(client, config);

  const items: SnapshotInfo[] = [];
  const stream = client.listObjectsV2(config.bucket, prefix, true);

  for await (const item of stream) {
    if (!item.name) continue;
    items.push({
      key: item.name,
      size: item.size ?? 0,
      lastModified: (item.lastModified ?? new Date()).toISOString(),
    });
  }

  return items.sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
}

/** Devuelve un stream legible con el contenido de un snapshot guardado previamente. */
export async function getSnapshotStream(client: ReturnType<typeof createMinioClient>, config: MinioConfig, key: string) {
  return client.getObject(config.bucket, key);
}
