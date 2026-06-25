import { getServiceClient } from "@/lib/supabase/server";
import {
  DEFAULT_AI,
  DEFAULT_COMPANY,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_RELEVANCE,
} from "@/lib/defaults";
import type {
  AISettings,
  CompanySettings,
  NotificationSettings,
  RelevanceSettings,
} from "@/lib/types";

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const sb = getServiceClient();
  const { data } = await sb.from("app_settings").select("value").eq("key", key).maybeSingle();
  return (data?.value as T) ?? fallback;
}

export async function updateSetting(key: string, value: unknown): Promise<void> {
  const sb = getServiceClient();
  await sb.from("app_settings").upsert({ key, value }, { onConflict: "key" });
}

export const getAISettings = () => getSetting<AISettings>("ai", DEFAULT_AI);
export const getRelevanceSettings = () => getSetting<RelevanceSettings>("relevance", DEFAULT_RELEVANCE);
export const getNotificationSettings = () =>
  getSetting<NotificationSettings>("notifications", DEFAULT_NOTIFICATIONS);
export const getCompanySettings = () => getSetting<CompanySettings>("company", DEFAULT_COMPANY);
