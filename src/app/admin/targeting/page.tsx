import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { dbConfigured } from "@/lib/supabase/server";
import { getTargetingProfile } from "@/lib/targeting/profile";
import { PageHeader } from "@/components/ui";
import { TargetingEditor } from "@/components/admin/TargetingEditor";
import { SetupNotice } from "@/components/SetupNotice";

export const dynamic = "force-dynamic";

export default async function TargetingPage() {
  if (!dbConfigured) {
    return (
      <>
        <PageHeader title="Targeting" subtitle="Five-dimension search profile" />
        <SetupNotice />
      </>
    );
  }
  const profile = await getTargetingProfile();
  return (
    <>
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-[0.82rem] text-[var(--color-muted)] hover:text-[var(--color-ink)] mb-3"
      >
        <ArrowLeft size={15} /> Admin
      </Link>
      <PageHeader
        title="Targeting profile"
        subtitle="The five-dimension search configuration: capabilities, vehicles, set-asides, agencies, exclusions — plus scoring weights, thresholds, and date bands. Edits apply to the next crawl; use “Re-score everything” to reclassify what's already stored."
      />
      <TargetingEditor initial={profile} />
    </>
  );
}
