"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  CartesianGrid,
  Legend,
} from "recharts";
import { PIPELINE_STYLES } from "@/lib/status";
import type { PipelineStage } from "@/lib/types";

const AXIS = { fontSize: 11, fill: "var(--color-muted)" };

export function StageChart({ data }: { data: { stage: PipelineStage; count: number }[] }) {
  const rows = data.map((d) => ({ name: PIPELINE_STYLES[d.stage].label, count: d.count, fill: PIPELINE_STYLES[d.stage].dot }));
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={rows} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis dataKey="name" tick={AXIS} interval={0} angle={-25} textAnchor="end" height={56} />
        <YAxis tick={AXIS} allowDecimals={false} />
        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--color-border)" }} />
        <Bar dataKey="count" radius={[5, 5, 0, 0]}>
          {rows.map((r, i) => (
            <Cell key={i} fill={r.fill} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ModeChart({ data }: { data: { mode: string; count: number }[] }) {
  const colors = ["var(--color-brand-500)", "var(--color-violet-500)"];
  const rows = data.map((d) => ({ name: d.mode === "STYLE_MATCHED" ? "Style-matched" : "LLM-original", value: d.count }));
  if (!rows.length) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Pie data={rows} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={85} paddingAngle={3}>
          {rows.map((_, i) => (
            <Cell key={i} fill={colors[i % colors.length]} />
          ))}
        </Pie>
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--color-border)" }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function StateChart({ data }: { data: { state: string; open: number; total: number }[] }) {
  if (!data.length) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis dataKey="state" tick={AXIS} />
        <YAxis tick={AXIS} allowDecimals={false} />
        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--color-border)" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="total" name="Total" fill="var(--color-brand-200)" radius={[5, 5, 0, 0]} />
        <Bar dataKey="open" name="Open" fill="var(--color-brand-500)" radius={[5, 5, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function Empty() {
  return <div className="h-[240px] grid place-items-center text-[0.82rem] text-[var(--color-muted)]">No data yet.</div>;
}
