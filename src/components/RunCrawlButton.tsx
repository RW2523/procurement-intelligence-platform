"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Check, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface Summary {
  sourceName: string;
  status: string;
  itemsFound: number;
  newCount: number;
  changedCount: number;
  closedCount: number;
  error?: string;
}

export function RunCrawlButton({
  source,
  label = "Run crawl",
  variant = "primary",
}: {
  source?: string;
  label?: string;
  variant?: "primary" | "ghost" | "soft";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Summary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(source ? { source } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data.summaries);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const totalNew = result?.reduce((s, r) => s + r.newCount, 0) ?? 0;
  const totalChanged = result?.reduce((s, r) => s + r.changedCount, 0) ?? 0;

  return (
    <div className="flex items-center gap-2">
      <button className={cn("btn", `btn-${variant}`)} onClick={run} disabled={busy}>
        <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
        {busy ? "Crawling…" : label}
      </button>
      {result && !busy && (
        <span className="text-[0.78rem] text-[var(--color-mint-700)] flex items-center gap-1">
          <Check size={14} /> {totalNew} new · {totalChanged} changed
        </span>
      )}
      {error && (
        <span className="text-[0.78rem] text-[var(--color-rose-700)] flex items-center gap-1">
          <AlertTriangle size={14} /> {error}
        </span>
      )}
    </div>
  );
}
