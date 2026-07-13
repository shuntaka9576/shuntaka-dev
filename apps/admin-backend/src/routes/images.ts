import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createRoute } from '@hono/zod-openapi';
import { requireEnv } from '../env.js';
import { newImageKey, thumbKey } from '../lib/images.js';
import { createRouter } from '../lib/router.js';
import { presignBodySchema, presignResponseSchema } from '../schemas/image.js';

const PRESIGN_EXPIRES_IN_SECONDS = 300;

let s3: S3Client | undefined;

const getS3 = (): S3Client => {
  s3 ??= new S3Client({});
  return s3;
};

const presignRoute = createRoute({
  method: 'post',
  path: '/images/presign',
  request: {
    body: { content: { 'application/json': { schema: presignBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: presignResponseSchema } },
      description: 'orig / thumb の presigned PUT URL を 2 本発行',
    },
  },
});

export const imageRoutes = createRouter().openapi(presignRoute, async (c) => {
  const body = c.req.valid('json');
  const bucket = requireEnv('IMAGES_BUCKET_NAME');
  const imageKey = newImageKey();
  const [origUrl, thumbUrl] = await Promise.all([
    getSignedUrl(
      getS3(),
      new PutObjectCommand({ Bucket: bucket, Key: imageKey, ContentType: body.contentType }),
      { expiresIn: PRESIGN_EXPIRES_IN_SECONDS },
    ),
    getSignedUrl(
      getS3(),
      new PutObjectCommand({
        Bucket: bucket,
        Key: thumbKey(imageKey),
        ContentType: body.contentType,
      }),
      { expiresIn: PRESIGN_EXPIRES_IN_SECONDS },
    ),
  ]);
  return c.json({ imageKey, origUrl, thumbUrl }, 200);
});
