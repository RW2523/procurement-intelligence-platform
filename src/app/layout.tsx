import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AlertTriangle } from "lucide-react";
import "./globals.css";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { ProductNav } from "@/components/ProductNav";
import { getShellData } from "@/lib/shell";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AJACE · Procurement Intelligence",
  description: "Discover, dedupe, draft, and track government procurement opportunities.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const shell = await getShellData();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <ProductNav current="procurement" />
        <div className="flex h-screen overflow-hidden">
          <Sidebar company={shell.company.name} />
          <div className="flex-1 flex flex-col min-w-0">
            <Topbar user={shell.user} unread={shell.unread} notifications={shell.notifications} />
            {!shell.dbConfigured && (
              <div className="flex items-center gap-2 px-6 py-2.5 bg-[var(--color-amber-100)] text-[var(--color-amber-700)] text-[0.82rem] border-b border-[var(--color-border)]">
                <AlertTriangle size={15} />
                <span>
                  Database not connected. Add <code className="font-mono">SUPABASE_SERVICE_ROLE_KEY</code> to{" "}
                  <code className="font-mono">.env.local</code> and restart to enable live data.
                </span>
              </div>
            )}
            <main className="flex-1 overflow-y-auto">
              <div className="max-w-[1280px] mx-auto px-6 py-7">{children}</div>
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
