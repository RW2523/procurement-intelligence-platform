import { getSetting, updateSetting } from "@/lib/db/settings";
import { getServiceClient } from "@/lib/supabase/server";
import type { TargetingProfile } from "@/lib/types";
import { DEFAULT_TARGETING_PROFILE } from "./defaults";

export { DEFAULT_TARGETING_PROFILE };

/** Read the live profile (falls back to the seed; callers always get a full profile). */
export async function getTargetingProfile(): Promise<TargetingProfile> {
  return getSetting<TargetingProfile>("targeting", DEFAULT_TARGETING_PROFILE);
}

/** Persist a profile update and record an audit version. */
export async function updateTargetingProfile(
  profile: TargetingProfile,
  changedBy = "admin",
  note?: string,
): Promise<TargetingProfile> {
  const sb = getServiceClient();
  const current = await getTargetingProfile();
  const next = { ...profile, version: (current.version ?? 0) + 1 };
  await updateSetting("targeting", next);
  await sb.from("targeting_profile_versions").insert({
    version_no: next.version,
    profile: next as unknown as Record<string, unknown>,
    changed_by: changedBy,
    note: note ?? null,
  });
  return next;
}
