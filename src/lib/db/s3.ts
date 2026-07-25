import "server-only";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

/**
 * S3 document storage, shaped like the Supabase storage API so src/lib/storage.ts
 * keeps its call sites. Objects live under a prefix in the SAME bucket the
 * timesheet app uses (it stores under ts-uploads/), so nothing collides.
 *
 * Credentials come from the EC2 instance role — never from env keys.
 */
const REGION = process.env.STORAGE_S3_REGION || "us-east-1";
const BUCKET = process.env.STORAGE_S3_BUCKET;
const PREFIX = process.env.STORAGE_S3_PREFIX || "proc-docs";

let _s3: S3Client | null = null;
const client = () => (_s3 ??= new S3Client({ region: REGION }));
const keyFor = (bucket: string, path: string) => `${PREFIX}/${bucket}/${path}`;

export function storage() {
  return {
    from(bucket: string) {
      return {
        async upload(path: string, body: Buffer, opts?: { contentType?: string; upsert?: boolean }) {
          // `upsert` is accepted for call-site compatibility: S3 PutObject always overwrites.
          try {
            await client().send(new PutObjectCommand({
              Bucket: BUCKET, Key: keyFor(bucket, path), Body: body,
              ContentType: opts?.contentType || "application/octet-stream",
            }));
            return { data: { path }, error: null as null | { message: string } };
          } catch (e: any) {
            return { data: null, error: { message: e?.message || String(e) } };
          }
        },
        async download(path: string) {
          try {
            const out = await client().send(
              new GetObjectCommand({ Bucket: BUCKET, Key: keyFor(bucket, path) }));
            const bytes = Buffer.from(await out.Body!.transformToByteArray());
            // Shaped like the Blob the Supabase SDK returned.
            const blob = {
              type: out.ContentType || "application/octet-stream",
              arrayBuffer: async () => bytes,
            };
            return { data: blob, error: null as null | { message: string } };
          } catch (e: any) {
            return { data: null, error: { message: e?.message || String(e) } };
          }
        },
        async remove(paths: string[]) {
          await Promise.all(paths.map((p) =>
            client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: keyFor(bucket, p) }))
              .catch(() => undefined)));
          return { data: null, error: null as null | { message: string } };
        },
      };
    },
  };
}
