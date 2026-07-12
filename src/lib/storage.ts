import "server-only";
import { getServiceClient } from "@/lib/supabase/server";

/**
 * Document bytes live in Supabase Storage (object storage), NOT in Postgres — base64
 * columns bloated the DB past the free-tier cap and starved query performance. The DB
 * keeps only metadata + extracted text; the bucket is private and streamed through the
 * app's authenticated file route.
 */
export const DOCUMENTS_BUCKET = "documents";

export async function uploadDocument(
  path: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const sb = getServiceClient();
  const { error } = await sb.storage.from(DOCUMENTS_BUCKET).upload(path, buffer, {
    contentType: contentType || "application/octet-stream",
    upsert: true,
  });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  return path;
}

export async function downloadDocument(
  path: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const sb = getServiceClient();
  const { data, error } = await sb.storage.from(DOCUMENTS_BUCKET).download(path);
  if (error || !data) throw new Error(`Storage download failed: ${error?.message ?? "not found"}`);
  return { buffer: Buffer.from(await data.arrayBuffer()), contentType: data.type || "application/octet-stream" };
}

export async function removeDocuments(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const sb = getServiceClient();
  await sb.storage.from(DOCUMENTS_BUCKET).remove(paths);
}
