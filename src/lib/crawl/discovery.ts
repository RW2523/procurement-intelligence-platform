import "server-only";
import * as cheerio from "cheerio";
import { request, fetchText, CookieJar } from "@/lib/connectors/http";
import { absolutize, clean } from "@/lib/connectors/parse";

/**
 * Advanced, generic document discovery. A detail-page URL goes in; a list of real
 * downloadable documents comes out. Several strategies run and their results union,
 * so a portal that hides its files behind JS handlers, ASP.NET servlets, or a
 * Dataverse notes API still yields documents. Adding a portal is adding a strategy.
 */
export interface DiscoveredDoc {
  filename: string;
  url: string;
  contentType?: string | null;
}

const DOC_RE = /\.(pdf|docx?|xlsx?|pptx?|rtf|txt|csv|zip)(?:$|\?|#)/i;
const DOC_HOST_HINTS =
  /(filedownload|bidattachment|getdocument|download\.aspx|download\.do|\/_entity\/annotation\/|attachment|blobstorage|document\.ashx|servlet\/download|showdocument|viewdocument)/i;
/** Anchor text that signals a document even when the href has no extension. */
const DOC_TEXT_HINTS = /\b(download|attachment|specification|amendment|addend|exhibit|scope of work|solicitation document|\.pdf|\.docx?|\.xlsx?)\b/i;

function hostOf(u: string): string {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return "";
  }
}

function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const original = u.searchParams.get("OriginalFileName") || u.searchParams.get("fileName");
    if (original) return original;
    const base = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    if (base && base.length > 2) return base;
  } catch {
    /* ignore */
  }
  return "document";
}

// ── Strategy 1: generic HTML (anchors, iframe/embed/object, viewer links) ──────
export function discoverGenericHtml(html: string, baseUrl: string): DiscoveredDoc[] {
  const $ = cheerio.load(html);
  const out: DiscoveredDoc[] = [];
  const push = (filename: string, href: string | undefined) => {
    const url = absolutize(baseUrl, href ?? "");
    if (!url) return;
    out.push({ filename: (clean(filename) || nameFromUrl(url)).slice(0, 200), url });
  };

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!href || href.startsWith("mailto:") || href.startsWith("javascript:") || href.startsWith("#")) return;
    const text = clean($(el).text());
    const isDoc = DOC_RE.test(href) || DOC_HOST_HINTS.test(href) || (DOC_TEXT_HINTS.test(text) && /[?/]/.test(href));
    if (isDoc) push(text || nameFromUrl(href), href);
  });
  // Embedded viewers frequently point straight at the file.
  $("iframe[src], embed[src], object[data]").each((_, el) => {
    const src = $(el).attr("src") ?? $(el).attr("data") ?? "";
    if (DOC_RE.test(src) || DOC_HOST_HINTS.test(src)) push(nameFromUrl(src), src);
  });
  return out;
}

// ── Strategy 2: COMMBUYS (MA) JS handler downloadFile('<fileNbr>') ─────────────
export function discoverCommbuys(html: string, baseUrl: string): DiscoveredDoc[] {
  let origin = "";
  let docId = "";
  try {
    const u = new URL(baseUrl);
    origin = u.origin;
    docId = u.searchParams.get("docId") ?? "";
  } catch {
    return [];
  }
  if (!/commbuys\.com/i.test(origin) || !docId) return [];
  const $ = cheerio.load(html);
  const out: DiscoveredDoc[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    const m = /downloadFile\(\s*['"]?(\d+)['"]?/.exec($(el).attr("href") ?? "");
    if (!m) return;
    const url =
      `${origin}/bso/external/bidDetail.sda?docId=${encodeURIComponent(docId)}` +
      `&downloadFileNbr=${m[1]}&mode=download&parentUrl=close&external=true`;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ filename: (clean($(el).text()) || `document-${m[1]}`).slice(0, 200), url });
  });
  return out;
}

// ── Strategy 3: Microsoft Power Pages / Dataverse notes API (NC eVP + any Power Pages) ──
const POWER_PAGES_ENTITY: Record<string, string> = {
  // host → regarding entity logical name (authoritative; page auto-detection is the fallback)
  "evp.nc.gov": "evp_solicitation",
};

function tokenFromHtml(html: string): string {
  // /_layout/tokenhtml returns hidden inputs; the anti-forgery token is the longest value.
  const vals = [...html.matchAll(/value="([^"]{24,})"/g)].map((m) => m[1]);
  return vals.sort((a, b) => b.length - a.length)[0] ?? "";
}

export async function discoverPowerPages(
  html: string,
  baseUrl: string,
  jar: CookieJar,
): Promise<DiscoveredDoc[]> {
  const notes = /\/_services\/entity-notes\/([0-9a-fA-F-]{36})/.exec(html);
  if (!notes) return [];
  const websiteId = notes[1];
  let origin = "";
  let recordId = "";
  try {
    const u = new URL(baseUrl);
    origin = u.origin;
    recordId = u.searchParams.get("id") ?? "";
  } catch {
    return [];
  }
  if (!origin || !recordId) return [];

  // Regarding entity logical name: host map first, else singularize the OData entity set.
  let logicalName = POWER_PAGES_ENTITY[hostOf(baseUrl)] ?? "";
  if (!logicalName) {
    const set = /@odata\.bind"\s*:\s*"\/([a-z0-9_]+)\(/i.exec(html)?.[1];
    if (set) logicalName = set.replace(/ies$/i, "y").replace(/s$/i, "");
  }
  if (!logicalName) return [];

  let token = "";
  try {
    token = tokenFromHtml(await fetchText(`${origin}/_layout/tokenhtml`, { jar, timeoutMs: 25_000 }));
  } catch {
    /* some Power Pages accept the request without a fresh token */
  }

  const body = JSON.stringify({
    regarding: { Id: recordId, LogicalName: logicalName, Name: null, KeyAttributes: [], RowVersion: null },
    orders: [{ Attribute: "createdon", Alias: null, Direction: null }],
    page: 1,
    pageSize: 100,
  });
  const r = await request(`${origin}/_services/entity-notes/${websiteId}`, {
    method: "POST",
    jar,
    timeoutMs: 40_000,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: baseUrl,
      ...(token ? { __RequestVerificationToken: token } : {}),
    },
    body,
  });
  if (!r.ok) return [];
  let json: { Records?: Record<string, unknown>[] };
  try {
    json = JSON.parse(r.text);
  } catch {
    return [];
  }
  const out: DiscoveredDoc[] = [];
  for (const rec of json.Records ?? []) {
    const url = (rec.AttachmentUrl as string) || (rec.AttachmentUrlWithTimeStamp as string);
    const name = rec.AttachmentFileName as string;
    if (!url || !name) continue;
    const abs = absolutize(origin, url);
    if (!abs) continue;
    out.push({ filename: String(name).slice(0, 200), url: abs, contentType: (rec.AttachmentContentType as string) ?? null });
  }
  return out;
}

/** Run every applicable strategy against a detail page and union the results. */
export async function discoverDocuments(
  html: string,
  baseUrl: string,
  jar: CookieJar,
): Promise<DiscoveredDoc[]> {
  const strategies: DiscoveredDoc[][] = [
    discoverCommbuys(html, baseUrl),
    discoverGenericHtml(html, baseUrl),
    await discoverPowerPages(html, baseUrl, jar).catch(() => []),
  ];
  const seen = new Set<string>();
  const out: DiscoveredDoc[] = [];
  for (const doc of strategies.flat()) {
    if (!doc.url || seen.has(doc.url)) continue;
    seen.add(doc.url);
    out.push(doc);
  }
  return out.slice(0, 30);
}
