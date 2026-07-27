import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { AlertTriangle } from "lucide-react";
import "./globals.css";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { NoProcurementAccess } from "@/components/NoProcurementAccess";
import { SignInRequired } from "@/lib/auth/page-gate";
import { PATHNAME_HEADER, isPublicPath } from "@/lib/auth/public-routes";
import { getShellData } from "@/lib/shell";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AJACE · Procurement Intelligence",
  description: "Discover, dedupe, draft, and track government procurement opportunities.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const shell = await getShellData();
  // /login and /no-access must render for someone with no procurement account;
  // an unconfigured database has no data to protect and shows the setup notice.
  // Everything else is gated. A missing pathname header counts as protected.
  const publicRoute = isPublicPath((await headers()).get(PATHNAME_HEADER)) || !shell.dbConfigured;
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <div className="flex h-screen overflow-hidden">
          <Sidebar company={shell.company.name} role={shell.user?.role ?? null} />
          <div className="flex-1 flex flex-col min-w-0">
            <Topbar user={shell.user} unread={shell.unread} notifications={shell.notifications} />
            {!shell.dbConfigured && (
              <div className="flex items-center gap-2 px-6 py-2.5 bg-[var(--color-amber-100)] text-[var(--color-amber-700)] text-[0.82rem] border-b border-[var(--color-border)]">
                <AlertTriangle size={15} />
                <span>
                  Database not connected. Set <code className="font-mono">DATABASE_URL</code> to the RDS
                  endpoint and restart to enable live data.
                </span>
              </div>
            )}
            <main className="flex-1 overflow-y-auto">
              <div className="max-w-[1280px] mx-auto px-6 py-7">
                {/* No usable procurement account: render the explanation INSTEAD of the
                    page, rather than redirecting — there is no redirect to loop on this way.

                    DEFENCE IN DEPTH, not the gate, and it never was one. Two reasons:
                    swapping `children` out here does not reliably stop the page segment from
                    rendering (notifications/page.tsx records a verified case where 100 rows
                    still reached the flight payload behind this refusal), and Next does not
                    re-render a mounted layout on client-side navigation at all
                    (docs 01-app/02-guides/authentication.md:1350), so a soft navigation or a
                    Link prefetch from the sidebar never passes through here. The enforcing
                    check is pageGate() in each route — see lib/auth/page-gate.tsx.

                    It also fails CLOSED now. The old condition was `shell.authed && !shell.user`,
                    which rendered the page whenever `authed` was false — and that covers more
                    than "signed out": getShellData() returns EMPTY on any error, and
                    getSessionEmail() returns null for a session whose session_version was
                    revoked while proxy.ts (signature only) still admits it. */}
                {publicRoute || shell.user ? (
                  children
                ) : shell.authed ? (
                  <NoProcurementAccess email={shell.email} deactivated={shell.access === "deactivated"} />
                ) : (
                  <SignInRequired />
                )}
              </div>
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
