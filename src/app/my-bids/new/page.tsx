import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { UploadBidForm } from "@/components/bids/UploadBidForm";

export default function NewBidPage() {
  return (
    <>
      <Link
        href="/my-bids"
        className="inline-flex items-center gap-1.5 text-[0.82rem] text-[var(--color-muted)] hover:text-[var(--color-ink)] mb-3"
      >
        <ArrowLeft size={15} /> My Bids
      </Link>
      <PageHeader
        title="Add a bid"
        subtitle="Bring a bid your team is already working on into the system. Attach the RFP documents — their text is extracted so the AI bid/no-bid check and response drafting read the real requirements."
      />
      <UploadBidForm />
    </>
  );
}
