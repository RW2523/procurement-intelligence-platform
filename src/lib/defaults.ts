import type {
  AISettings,
  RelevanceSettings,
  NotificationSettings,
  CompanySettings,
} from "@/lib/types";

export const DEFAULT_COMPANY: CompanySettings = {
  name: "AJACE",
  tagline: "Procurement Intelligence & Response Automation",
  about: "AJACE delivers software, data, and managed services to public-sector agencies.",
};

export const DEFAULT_AI: AISettings = {
  provider: "openrouter",
  generation_model: "openai/gpt-4o",
  draft_model: "openai/gpt-4o-mini",
  summary_model: "openai/gpt-4o-mini",
  embedding_mode: "local",
  embedding_model: "openai/text-embedding-3-small",
  temperature: 0.4,
  auto_draft: false,
};

export const DEFAULT_RELEVANCE: RelevanceSettings = {
  keywords: [
    "software",
    "data",
    "cloud",
    "it services",
    "application",
    "platform",
    "managed services",
    "cybersecurity",
    "analytics",
    "saas",
    "integration",
    "digital",
  ],
  naics: ["541511", "541512", "541513", "541519", "518210", "541611", "541618"],
  min_value: 0,
  auto_draft_threshold: 70,
};

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  deadline_reminder_days: [7, 3, 1],
  qa_reminder_days: [3, 1],
  email_enabled: false,
  slack_enabled: false,
};

/** Number of days within which an open opportunity is flagged "closing soon". */
export const CLOSING_SOON_DAYS = 7;
