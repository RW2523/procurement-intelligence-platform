import type { CSSProperties } from "react";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabase/auth-server";

const inputStyle: CSSProperties = {
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  padding: "9px 11px",
  fontSize: 14,
  outline: "none",
};

async function login(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const supabase = await createAuthServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect("/");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "grid",
        placeItems: "center",
        background: "#0b1020",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
      }}
    >
      <form
        action={login}
        style={{
          width: 320,
          background: "#fff",
          borderRadius: 14,
          padding: 28,
          boxShadow: "0 10px 40px rgba(0,0,0,0.35)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ fontWeight: 800, fontSize: 18, color: "#4f46e5", letterSpacing: "0.02em" }}>AJACE</div>
        <div style={{ fontSize: 14, color: "#475569", marginTop: -6 }}>Procurement Intelligence — sign in</div>
        {error ? (
          <div style={{ background: "#fef2f2", color: "#b91c1c", fontSize: 12.5, padding: "8px 10px", borderRadius: 8 }}>
            {error}
          </div>
        ) : null}
        <input name="email" type="email" placeholder="Work email" required autoComplete="email" style={inputStyle} />
        <input
          name="password"
          type="password"
          placeholder="Password"
          required
          autoComplete="current-password"
          style={inputStyle}
        />
        <button
          type="submit"
          style={{
            marginTop: 4,
            background: "#4f46e5",
            color: "#fff",
            border: 0,
            borderRadius: 8,
            padding: "10px 12px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Sign in
        </button>
        <div style={{ fontSize: 11.5, color: "#94a3b8" }}>
          Use your AJACE account — the same login works across Immigration, Procurement, and Timesheets.
        </div>
      </form>
    </div>
  );
}
