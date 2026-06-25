import { createHash } from "crypto";
import type { NormalizedOpportunity } from "@/lib/types";

/**
 * Fingerprint of the *meaningful* fields. Used as the change-detection key: if the
 * hash is unchanged we touch last_seen_at and do nothing else (no re-processing).
 */
export function contentHash(o: NormalizedOpportunity): string {
  const material = JSON.stringify([
    (o.title || "").trim().toLowerCase(),
    (o.agency || "").trim().toLowerCase(),
    o.dueDate || "",
    o.qAndADeadline || "",
    (o.description || "").trim().toLowerCase(),
    o.estimatedValue ?? "",
    (o.statusOnSite || "").trim().toLowerCase(),
    (o.attachmentUrls || []).map((a) => a.url).sort().join("|"),
  ]);
  return createHash("sha256").update(material).digest("hex");
}

/** Fallback natural key when a portal has no stable external id. */
export function fallbackExternalId(o: NormalizedOpportunity): string {
  return createHash("sha256")
    .update(`${o.title}|${o.agency ?? ""}|${o.dueDate ?? ""}`.toLowerCase())
    .digest("hex")
    .slice(0, 24);
}
