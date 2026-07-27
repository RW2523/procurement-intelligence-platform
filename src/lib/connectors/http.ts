import { isIP } from "node:net";
import { config } from "@/lib/config";
import { canonicalHost, safeFetch, SsrfBlockedError } from "./ssrf";

export {
  SsrfBlockedError,
  assertPublicUrl,
  assertPublicUrlResolved,
  canonicalHost,
  classifyIp,
  safeFetch,
} from "./ssrf";
export type { ResolveFn, SafeFetchOptions } from "./ssrf";

interface StoredCookie {
  name: string;
  value: string;
  /** Host the cookie is scoped to: lowercase, no leading dot, no trailing dot. */
  domain: string;
  /** true = only exactly `domain`; false = `domain` and its subdomains. */
  hostOnly: boolean;
  /** Set-Cookie carried `Secure` — never replay it over plain http. */
  secure: boolean;
}

/** Hostname of a URL, canonicalised the same way the SSRF gate does. */
function hostOfUrl(url: string): string {
  try {
    return canonicalHost(new URL(url).hostname);
  } catch {
    return "";
  }
}

/** `host` is `domain` or a subdomain of it. */
function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function parseSetCookie(line: string, requestHost: string): StoredCookie | null {
  const parts = line.split(";");
  const pair = parts[0];
  const eq = pair.indexOf("=");
  if (eq === -1) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;

  let domain = requestHost;
  let hostOnly = true;
  let secure = false;
  for (const attr of parts.slice(1)) {
    const i = attr.indexOf("=");
    const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? "" : attr.slice(i + 1).trim();
    if (key === "secure") {
      secure = true;
    } else if (key === "domain" && val) {
      // A host may widen a cookie to its own registrable parent, never to an
      // unrelated host and never to a bare TLD ("Domain=gov"). Anything else is
      // IGNORED rather than honoured: the cookie stays host-only, which is the
      // restrictive outcome.
      const d = canonicalHost(val.replace(/^\./, ""));
      if (!d || !d.includes(".") || isIP(requestHost)) continue;
      if (!domainMatches(requestHost, d)) continue;
      domain = d;
      hostOnly = false;
    }
  }
  return { name, value, domain, hostOnly, secure };
}

/**
 * Minimal cookie jar built on Node's fetch (undici). Many state portals hand out
 * a session cookie on the first GET that must be replayed on subsequent requests
 * (NC Dataverse, PA ViewState, MA ALB stickiness).
 *
 * COOKIES ARE SCOPED TO THE HOST THAT SET THEM. This is not a nicety: a single
 * jar is deliberately reused across a whole portal visit — see
 * src/lib/crawl/attachments.ts, which seeds a jar from an opportunity's detail
 * page and then fetches document URLs SCRAPED OUT OF THAT PAGE. Those URLs point
 * wherever the remote page says, so an unscoped jar hands the portal's session
 * cookie to an attacker-chosen host on the FIRST request — no redirect involved,
 * so safeFetch's cross-origin header stripping (a redirect-hop defence) never
 * runs. The scope check therefore has to live here, in the jar.
 *
 * Path scoping is deliberately NOT implemented: it is not a security boundary
 * (any path on the host can read the cookie anyway), and guessing default-path
 * semantics wrong would silently break portals that seed a session on a detail
 * page and spend it on an unrelated API path (NC eVP does exactly that).
 */
export class CookieJar {
  private jar = new Map<string, StoredCookie>();

  /**
   * Record Set-Cookie from one response. `requestUrl` is the URL that response
   * came from — the scope the cookies are bound to. It defaults to `res.url`,
   * but callers inside safeFetch pass the per-hop URL explicitly, because
   * `res.url` is empty on synthetic Responses.
   */
  ingest(res: Response, requestUrl?: string) {
    const host = hostOfUrl(requestUrl ?? res.url ?? "");
    // No host to scope to → store nothing. Guessing here is what the leak was.
    if (!host) return;
    // Node 18+/undici exposes getSetCookie(); fall back to single header.
    const raw =
      (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ??
      (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
    for (const line of raw) {
      const c = parseSetCookie(line, host);
      if (c) this.jar.set(`${c.domain}\u0000${c.hostOnly ? "h" : "d"}\u0000${c.name}`, c);
    }
  }

  /** The Cookie header to send to `requestUrl` — "" when nothing is in scope. */
  header(requestUrl: string): string {
    const host = hostOfUrl(requestUrl);
    if (!host) return "";
    let https = false;
    try {
      https = new URL(requestUrl).protocol === "https:";
    } catch {
      return "";
    }
    const out: string[] = [];
    for (const c of this.jar.values()) {
      if (c.secure && !https) continue;
      if (c.hostOnly ? host !== c.domain : !domainMatches(host, c.domain)) continue;
      out.push(`${c.name}=${c.value}`);
    }
    return out.join("; ");
  }

  get size() {
    return this.jar.size;
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  jar?: CookieJar;
  timeoutMs?: number;
  signal?: AbortSignal;
  redirect?: RequestRedirect;
}

export interface FetchResult {
  res: Response;
  text: string;
  status: number;
  ok: boolean;
}

/** Browser-like fetch with timeout, UA, and cookie-jar integration. */
export async function request(url: string, opts: RequestOptions = {}): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? config.crawl.requestTimeoutMs);
  // Chain a caller-supplied signal into our timeout controller.
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    ...opts.headers,
  };
  // No Cookie header is set here: safeFetch asks the jar per hop, so each host
  // only ever sees the cookies scoped to it.

  try {
    let lastErr: unknown;
    // Retry transient network failures (gov portals are occasionally flaky) — but
    // never retry a real HTTP response; that's the connector's decision.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // safeFetch applies the SSRF gate to the initial URL and to EVERY
        // redirect hop, and feeds the jar per hop (browsers keep Set-Cookie
        // from intermediate 3xx responses; undici's auto-follow drops them).
        const res = await safeFetch(url, {
          method: opts.method ?? "GET",
          headers,
          body: opts.body,
          redirect: opts.redirect ?? "follow",
          signal: controller.signal,
          onResponse: (r, hopUrl) => opts.jar?.ingest(r, hopUrl),
          cookieHeaderFor: opts.jar ? (u) => opts.jar!.header(u.toString()) : undefined,
        });
        const text = await res.text();
        return { res, text, status: res.status, ok: res.ok };
      } catch (e) {
        lastErr = e;
        // A blocked URL is a permanent decision, never a transient failure.
        if (e instanceof SsrfBlockedError) break;
        if (controller.signal.aborted || attempt === 1) break;
        await sleep(900);
      }
    }
    throw lastErr;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchText(url: string, opts: RequestOptions = {}): Promise<string> {
  const r = await request(url, opts);
  if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status}`);
  return r.text;
}

export async function fetchJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
  const r = await request(url, opts);
  if (!r.ok) throw new Error(`${opts.method ?? "GET"} ${url} -> HTTP ${r.status}`);
  return JSON.parse(r.text) as T;
}

/**
 * Fetch a URL as binary (for downloading attachment documents).
 *
 * The SSRF gate lives in ./ssrf.ts and is applied by safeFetch to the initial
 * URL and to every redirect hop. The old in-file guard checked only the first
 * hop, missed IPv4-mapped IPv6 and trailing-dot hosts, and did not cover
 * request()/fetchText() at all.
 */
export async function fetchBuffer(
  url: string,
  opts: RequestOptions & { maxBytes?: number } = {},
): Promise<{ buffer: Buffer; contentType: string; status: number; finalUrl: string; tooLarge?: boolean; byteSize?: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? config.crawl.requestTimeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "*/*",
    ...opts.headers,
  };
  // Cookies come from the jar per hop inside safeFetch — see request() above.
  // This path is the one that fetches SCRAPED document URLs, so an unscoped
  // Cookie header here is exactly the leak the jar's scoping now prevents.
  try {
    let lastErr: unknown;
    // Government CDNs occasionally reset the TLS connection — retry transient failures.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await safeFetch(url, {
          method: opts.method ?? "GET",
          headers,
          redirect: opts.redirect ?? "follow",
          signal: controller.signal,
          onResponse: (r, hopUrl) => opts.jar?.ingest(r, hopUrl),
          cookieHeaderFor: opts.jar ? (u) => opts.jar!.header(u.toString()) : undefined,
        });
        // REFUSE BEFORE ALLOCATING. The old code buffered the entire response and
        // only then compared its length to the 40 MB cap — so the cap never
        // bounded peak memory, it just decided what to do after the damage. On a
        // 2 GB box with no swap, and Buffers being OFF-HEAP, one 300 MB state
        // plan set goes straight at system RAM and the kernel OOM killer may
        // pick the payroll app rather than this crawler.
        const maxBytes = opts.maxBytes;
        if (maxBytes) {
          const declared = Number(res.headers.get("content-length") || 0);
          if (declared > maxBytes) {
            // Portals serving static documents almost always send Content-Length,
            // so this header check alone removes most of the exposure.
            await res.body?.cancel().catch(() => undefined);
            return {
              buffer: Buffer.alloc(0),
              contentType: res.headers.get("content-type") ?? "application/octet-stream",
              status: res.status,
              finalUrl: res.url || url,
              tooLarge: true,
              byteSize: declared,
            };
          }
          // Chunked / no Content-Length: count as it streams and abort at the cap.
          if (!declared && res.body) {
            const chunks: Uint8Array[] = [];
            let total = 0;
            for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
              total += chunk.byteLength;
              if (total > maxBytes) {
                controller.abort();
                return {
                  buffer: Buffer.alloc(0),
                  contentType: res.headers.get("content-type") ?? "application/octet-stream",
                  status: res.status,
                  finalUrl: res.url || url,
                  tooLarge: true,
                  byteSize: total,
                };
              }
              chunks.push(chunk);
            }
            return {
              buffer: Buffer.concat(chunks),
              contentType: res.headers.get("content-type") ?? "application/octet-stream",
              status: res.status,
              finalUrl: res.url || url,
            };
          }
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        return {
          buffer,
          contentType: res.headers.get("content-type") ?? "application/octet-stream",
          status: res.status,
          finalUrl: res.url || url,
        };
      } catch (e) {
        lastErr = e;
        if (e instanceof SsrfBlockedError) break;
        if (controller.signal.aborted || attempt === 2) break;
        await sleep(1000);
      }
    }
    throw lastErr;
  } finally {
    clearTimeout(timeout);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
