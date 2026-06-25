import { BookOpen, Layers } from "lucide-react";
import { dbConfigured } from "@/lib/supabase/server";
import { listKnowledge } from "@/lib/db/knowledge";
import { Card, CardHeader, PageHeader, Badge, EmptyState } from "@/components/ui";
import { KnowledgeForm } from "@/components/knowledge/KnowledgeForm";
import { KnowledgeDelete } from "@/components/knowledge/KnowledgeDelete";
import { SetupNotice } from "@/components/SetupNotice";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const OUTCOME_STYLE: Record<string, { bg: string; fg: string }> = {
  won: { bg: "var(--color-mint-100)", fg: "var(--color-mint-700)" },
  lost: { bg: "var(--color-rose-100)", fg: "var(--color-rose-700)" },
  unknown: { bg: "#eef0f4", fg: "#5b6170" },
};

export default async function KnowledgePage() {
  if (!dbConfigured) {
    return (
      <>
        <PageHeader title="Knowledge Library" subtitle="Past proposals that teach the AI your voice" />
        <SetupNotice />
      </>
    );
  }
  const docs = await listKnowledge();
  const totalChunks = docs.reduce((s, d) => s + d.chunk_count, 0);

  return (
    <>
      <PageHeader
        title="Knowledge Library"
        subtitle={`${docs.length} proposals · ${totalChunks} embedded chunks powering style-matched (RAG) drafting`}
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div>
          <h3 className="text-[0.9rem] font-semibold text-[var(--color-ink)] mb-2">Add a past proposal</h3>
          <KnowledgeForm />
        </div>
        <div>
          <h3 className="text-[0.9rem] font-semibold text-[var(--color-ink)] mb-2">Library</h3>
          {docs.length === 0 ? (
            <Card>
              <EmptyState
                icon={<BookOpen size={30} />}
                title="No proposals yet"
                description="Add a few past proposals (ideally winners). The AI retrieves the most relevant ones to write in your company's voice."
              />
            </Card>
          ) : (
            <div className="space-y-3">
              {docs.map((d) => {
                const o = OUTCOME_STYLE[d.outcome] ?? OUTCOME_STYLE.unknown;
                return (
                  <Card key={d.id} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[0.9rem] font-medium text-[var(--color-ink)]">{d.title}</div>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <Badge label={d.outcome} bg={o.bg} fg={o.fg} />
                          {d.category && <span className="chip">{d.category}</span>}
                          <span className="chip flex items-center gap-1"><Layers size={11} /> {d.chunk_count} chunks</span>
                          <span className="text-[0.72rem] text-[var(--color-faint)]">{fmtDate(d.created_at)}</span>
                        </div>
                        {d.tags.length > 0 && (
                          <div className="flex gap-1 mt-1.5 flex-wrap">
                            {d.tags.map((t) => <span key={t} className="text-[0.7rem] text-[var(--color-brand-600)]">#{t}</span>)}
                          </div>
                        )}
                      </div>
                      <KnowledgeDelete id={d.id} />
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
