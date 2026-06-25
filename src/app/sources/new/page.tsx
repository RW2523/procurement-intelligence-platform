import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { AddSourceForm } from "@/components/sources/AddSourceForm";

export default function NewSourcePage() {
  return (
    <>
      <Link href="/sources" className="inline-flex items-center gap-1.5 text-[0.82rem] text-[var(--color-muted)] hover:text-[var(--color-ink)] mb-3">
        <ArrowLeft size={15} /> Sources
      </Link>
      <PageHeader
        title="Add a portal"
        subtitle="Register a new procurement portal, its schedule, and which connector module serves it. New connectors are still built in code — this form registers and schedules the source."
      />
      <AddSourceForm />
    </>
  );
}
