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

export async function verifyStorage(client: ReturnType<typeof createMinioClient>, config: MinioConfig) {
  const bucket = config.bucket;
  try {
    const exists = await client.bucketExists(bucket);
    if (!exists) {
      await client.makeBucket(bucket, config.region);
    }

    await client.putObject(bucket, 'health-check.txt', 'ok');
    const stream = await client.getObject(bucket, 'health-check.txt');

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString('utf-8');
  } catch (error) {
    throw new Error(`MinIO health check failed: ${error}`);
  }
}
