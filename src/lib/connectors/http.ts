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

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
