import { pageGate } from "@/lib/auth/page-gate";

/**
 * Authorization for the /opportunities segment — the list page and every
 * opportunity detail page under it.
 *
 * This is a SEGMENT layout, not the root layout, and that difference is the
 * whole point. The root layout is already mounted on every screen, so Next never
 * re-renders it on a client-side navigation and its check is skipped (see
 * node_modules/next/dist/docs/01-app/02-guides/authentication.md:1350). This
 * layout is not mounted until the router enters /opportunities, so it renders —
 * and therefore checks — on every entry into the segment, including a Link
 * prefetch from the sidebar, which is precisely how an unauthorized user reached
 * the opportunity list before.
 *
 * opportunities/[id]/page.tsx calls pageGate() as well, so navigating between
 * two opportunities inside the segment (where this layout is reused, not
 * re-rendered) is still checked per request.
 */
export default async function OpportunitiesLayout({ children }: { children: React.ReactNode }) {
  const { deny } = await pageGate();
  if (deny) return deny;
  return children;
}
