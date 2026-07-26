import { config } from "@/lib/config";

/**
 * Minimal cookie jar built on Node's fetch (undici). Many state portals hand out
 * a session cookie on the first GET that must be replayed on subsequent requests
 * (NC Dataverse, PA ViewState, MA ALB stickiness).
 */
export class CookieJar {
  private jar = new Map<string, string>();

  ingest(res: Response) {
    // Node 18+/undici exposes getSetCookie(); fall back to single header.
    const raw =
      (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ??
      (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
    for (const line of raw) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name) this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
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
  if (opts.jar && opts.jar.size > 0) headers["Cookie"] = opts.jar.header();

  try {
    let lastErr: unknown;
    // Retry transient network failures (gov portals are occasionally flaky) — but
    // never retry a real HTTP response; that's the connector's decision.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: opts.method ?? "GET",
          headers,
          body: opts.body,
          redirect: opts.redirect ?? "follow",
          signal: controller.signal,
        });
        if (opts.jar) opts.jar.ingest(res);
        const text = await res.text();
        return { res, text, status: res.status, ok: res.ok };
      } catch (e) {
        lastErr = e;
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

/** Fetch a URL as binary (for downloading attachment documents). */

/**
 * Block requests that would reach the instance itself or the private network.
 *
 * Attachment URLs are SCRAPED OUT OF REMOTE PORTAL HTML, so they are not
 * operator-supplied: a hostile or compromised portal can point them anywhere.
 * On EC2 the most valuable target is 169.254.169.254 — the instance metadata
 * service — whose role holds this box's S3 and SES rights, and this box also
 * runs payroll. Redirects are followed, so the check must run per-hop.
 */
const BLOCKED_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "localhost"]);
function assertPublicUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`invalid URL: ${raw}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`blocked scheme: ${u.protocol}`);
  }
  const h = u.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(h) || h.endsWith(".localhost") || h === "0.0.0.0") {
    throw new Error(`blocked host: ${h}`);
  }
  // Literal private/loopback/link-local ranges. Hostnames that RESOLVE into
  // private space are not covered here — that needs a resolving agent — but the
  // metadata endpoint and localhost are always literals in practice.
  if (/^(127\.|10\.|169\.254\.|192\.168\.|::1$|\[?::1)/.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)) {
    throw new Error(`blocked private address: ${h}`);
  }
  return u;
}

export async function fetchBuffer(
  url: string,
  opts: RequestOptions & { maxBytes?: number } = {},
): Promise<{ buffer: Buffer; contentType: string; status: number; finalUrl: string; tooLarge?: boolean; byteSize?: number }> {
  assertPublicUrl(url);
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
  if (opts.jar && opts.jar.size > 0) headers["Cookie"] = opts.jar.header();
  try {
    let lastErr: unknown;
    // Government CDNs occasionally reset the TLS connection — retry transient failures.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: opts.method ?? "GET",
          headers,
          redirect: opts.redirect ?? "follow",
          signal: controller.signal,
        });
        if (opts.jar) opts.jar.ingest(res);
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
