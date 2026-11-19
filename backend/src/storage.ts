import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Trip media goes straight from the phone to S3 through presigned PUT URLs, so video never passes through the API.
export const BUCKET = process.env.MEDIA_BUCKET;
if (!BUCKET) throw new Error('MEDIA_BUCKET is not set (the S3 bucket for trip media, e.g. travelbuddy-media-dev-<account>)');
export const s3 = new S3Client({});

export const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  jpg: 'image/jpeg',
};

export const presignUpload = (key: string, contentType: string) =>
  getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }), { expiresIn: 900 });

export const presignView = (key: string) => getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });
