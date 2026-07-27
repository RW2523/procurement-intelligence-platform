/**
 * SSRF gate for every outbound fetch this app makes.
 *
 * WHY THIS EXISTS
 * ---------------
 * The crawler fetches URLs that are SCRAPED OUT OF REMOTE PORTAL HTML. They are
 * not operator-supplied, so a hostile or compromised procurement portal chooses
 * where we connect. On this box that is unusually dangerous:
 *
 *   - 169.254.169.254 is the EC2 instance metadata service. IMDSv2 requires a
 *     PUT to mint a token, which raises the bar but does NOT close the hole
 *     (a PUT is one `opts.method` away, and IMDSv1 may be re-enabled), so
 *     link-local is blocked outright.
 *   - 127.0.0.1:3009 is the PAYROLL app on the same instance, and its
 *     /api/admin/export endpoint is one hop away over loopback.
 *
 * WHAT IS ENFORCED
 * ----------------
 *  1. Scheme must be http/https. No file:, gopher:, data:, blob:.
 *  2. No credentials in the URL (http://portal.gov@169.254.169.254/ reads as
 *     the portal in a log line but connects to the metadata service).
 *  3. Literal addresses are classified in full: IPv4 (all non-public ranges),
 *     IPv6, and every IPv6 form that smuggles an IPv4 address — IPv4-mapped
 *     (::ffff:169.254.169.254), IPv4-compatible, NAT64 (64:ff9b::/96),
 *     6to4 (2002::/16) and Teredo (2001::/32).
 *  4. Hostnames are canonicalised first: lowercased, brackets stripped,
 *     TRAILING DOTS stripped ("localhost." and "169.254.169.254." are the same
 *     host to the resolver but not to a naive string compare). Decimal, octal
 *     and hex IPv4 forms (http://2852039166/, http://0177.0.0.1/) are already
 *     canonicalised to dotted quad by the WHATWG URL parser, and are then
 *     classified as literals.
 *  5. Hostnames are RESOLVED and EVERY returned address is classified, not just
 *     the first — a rebinding record that mixes one public and one private
 *     answer is rejected.
 *  6. EVERY REDIRECT HOP is re-validated. This is the hop that the previous
 *     version missed entirely: http://evil.example/r -> 169.254.169.254 walked
 *     straight through, because only the first URL was ever checked.
 *
 * RESIDUAL RISK: DNS REBINDING (documented, not fully closed)
 * ----------------------------------------------------------
 * A perfect fix pins the resolved address and connects to it. Node's global
 * `fetch` gives no hook for that: the only way to supply a custom `lookup` is a
 * `dispatcher`/`Agent` from `undici`, which is NOT a declared dependency of this
 * project (it is present only as a transitive one) and pulling it into the Next
 * server bundle on a 2 GB box is a deployment risk we are not taking for this.
 * Rewriting the URL to the literal IP and setting a Host header is not an
 * option either — it breaks TLS SNI and certificate validation on https, which
 * is nearly every portal we crawl.
 *
 * So instead we shrink the window rather than close it:
 *   - all A/AAAA answers must be public, so the cheap "one public + one private
 *     answer" trick fails;
 *   - the check runs immediately before the fetch of that specific hop, so the
 *     attacker's window is the few milliseconds between our lookup and the
 *     socket's, and they must also win the OS resolver cache race with a TTL
 *     they do not control on our side.
 * A determined attacker with a 0-TTL record CAN still win that race. The
 * defence-in-depth answer is network-level (egress rules / IMDS hop limit),
 * not code-level, and is out of scope for this file.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Thrown when a URL is refused by the gate. Never retried by callers. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** Hostnames that are never legitimate crawl targets, regardless of resolution. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** Suffixes that are never legitimate crawl targets. */
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local", // mDNS — LAN only
  ".internal", // GCP metadata + AWS *.compute.internal
  ".home.arpa",
];

/**
 * Lowercase, strip IPv6 brackets, strip trailing dots.
 * `new URL("http://localhost./").hostname === "localhost."` — the resolver
 * treats that as `localhost`, so a naive Set lookup misses it.
 */
export function canonicalHost(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.replace(/\.+$/, "");
  return h;
}

function ipv4Reason(ip: string): string | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return "malformed IPv4";
  const p = parts.map((s) => Number(s));
  if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return "malformed IPv4";
  const [a, b] = p as [number, number, number, number];
  if (a === 0) return "unspecified/this-network 0.0.0.0/8";
  if (a === 10) return "private 10.0.0.0/8";
  if (a === 127) return "loopback 127.0.0.0/8";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT 100.64.0.0/10";
  if (a === 169 && b === 254) return "link-local / cloud metadata 169.254.0.0/16";
  if (a === 172 && b >= 16 && b <= 31) return "private 172.16.0.0/12";
  if (a === 192 && b === 0) return "IETF protocol assignments 192.0.0.0/24";
  if (a === 192 && b === 168) return "private 192.168.0.0/16";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking 198.18.0.0/15";
  if (a >= 224 && a <= 239) return "multicast 224.0.0.0/4";
  if (a >= 240) return "reserved 240.0.0.0/4";
  return null;
}

/** Expand an IPv6 literal to its 8 numeric groups. Returns null if malformed. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip;
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone); // scope id, e.g. fe80::1%en0
  let tail4: number[] | null = null;
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    if (isIP(maybeV4) !== 4) return null;
    const q = maybeV4.split(".").map(Number);
    tail4 = [(q[0] << 8) | q[1], (q[2] << 8) | q[3]];
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toNums = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toNums(halves[0]);
  const tail = halves.length === 2 ? toNums(halves[1]) : [];
  if (!head || !tail) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail4) {
    groups[6] = tail4[0];
    groups[7] = tail4[1];
  }
  return groups;
}

const v4of = (hi: number, lo: number) =>
  `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;

function ipv6Reason(ip: string): string | null {
  const g = ipv6Groups(ip);
  if (!g) return "malformed IPv6";
  const allZero = g.every((x) => x === 0);
  if (allZero) return "unspecified ::";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback ::1";

  // IPv4-mapped ::ffff:a.b.c.d — THE bypass this guard used to miss.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const v4 = v4of(g[6], g[7]);
    return ipv4Reason(v4) ? `IPv4-mapped ${v4} (${ipv4Reason(v4)})` : null;
  }
  // IPv4-compatible ::a.b.c.d (deprecated but still routed by some stacks).
  if (g.slice(0, 6).every((x) => x === 0)) {
    const v4 = v4of(g[6], g[7]);
    return ipv4Reason(v4) ? `IPv4-compatible ${v4} (${ipv4Reason(v4)})` : null;
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    const v4 = v4of(g[6], g[7]);
    return `NAT64-embedded ${v4}${ipv4Reason(v4) ? ` (${ipv4Reason(v4)})` : ""}`;
  }
  // 6to4 2002::/16 carries the IPv4 address in groups 1-2.
  if (g[0] === 0x2002) {
    const v4 = v4of(g[1], g[2]);
    return `6to4-embedded ${v4}${ipv4Reason(v4) ? ` (${ipv4Reason(v4)})` : ""}`;
  }
  // Teredo 2001:0000::/32 — server in groups 2-3, client obfuscated in 6-7.
  if (g[0] === 0x2001 && g[1] === 0x0000) {
    const client = v4of(g[6] ^ 0xffff, g[7] ^ 0xffff);
    return `Teredo-embedded ${client}`;
  }
  if ((g[0] & 0xfe00) === 0xfc00) return "unique local fc00::/7";
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local fe80::/10";
  if ((g[0] & 0xffc0) === 0xfec0) return "site-local fec0::/10";
  if ((g[0] & 0xff00) === 0xff00) return "multicast ff00::/8";
  return null;
}

/** Returns a human-readable reason if `ip` is not a public address, else null. */
export function classifyIp(ip: string): string | null {
  const v = isIP(ip);
  if (v === 4) return ipv4Reason(ip);
  if (v === 6) return ipv6Reason(ip);
  // Not a literal at all — try our own IPv6 parser (covers zone ids etc).
  return ipv6Reason(ip) ?? "not an IP address";
}

/** If `host` is a literal IP (already bracket-stripped), return it, else null. */
function literalIpOf(host: string): string | null {
  return isIP(host) ? host : null;
}

function blockedNameReason(host: string): string | null {
  if (!host) return "empty hostname";
  if (BLOCKED_HOSTNAMES.has(host)) return "reserved hostname";
  for (const s of BLOCKED_SUFFIXES) if (host.endsWith(s)) return `reserved suffix ${s}`;
  return null;
}

/**
 * Synchronous checks: scheme, credentials, reserved names, literal addresses.
 * Does NOT resolve DNS — use {@link assertPublicUrlResolved} for the real gate.
 */
export function assertPublicUrl(raw: string, base?: string | URL): URL {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    throw new SsrfBlockedError(`invalid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SsrfBlockedError(`blocked scheme ${u.protocol} in ${raw}`);
  }
  if (u.username || u.password) {
    throw new SsrfBlockedError(`credentials in URL are not allowed: ${u.protocol}//${u.host}`);
  }
  const host = canonicalHost(u.hostname);
  const literal = literalIpOf(host);
  if (literal) {
    const reason = classifyIp(literal);
    if (reason) throw new SsrfBlockedError(`blocked address ${host}: ${reason}`);
  } else {
    const reason = blockedNameReason(host);
    if (reason) throw new SsrfBlockedError(`blocked host ${host}: ${reason}`);
  }
  return u;
}

export type ResolveFn = (host: string) => Promise<string[]>;

const defaultResolve: ResolveFn = async (host) => {
  const rows = await lookup(host, { all: true, verbatim: true });
  return rows.map((r) => r.address);
};

/**
 * The real gate: everything {@link assertPublicUrl} does, plus DNS resolution
 * with EVERY returned address classified.
 */
export async function assertPublicUrlResolved(
  raw: string,
  opts: { base?: string | URL; resolve?: ResolveFn } = {},
): Promise<{ url: URL; addresses: string[] }> {
  const url = assertPublicUrl(raw, opts.base);
  const host = canonicalHost(url.hostname);
  const literal = literalIpOf(host);
  if (literal) return { url, addresses: [literal] };

  let addresses: string[];
  try {
    addresses = await (opts.resolve ?? defaultResolve)(host);
  } catch (e) {
    throw new SsrfBlockedError(
      `cannot resolve host ${host}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!addresses.length) throw new SsrfBlockedError(`host ${host} resolved to no addresses`);
  for (const a of addresses) {
    const reason = classifyIp(a);
    if (reason) throw new SsrfBlockedError(`blocked host ${host}: resolves to ${a} — ${reason}`);
  }
  return { url, addresses };
}

// ── Redirect-safe fetch ──────────────────────────────────────────────────────

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Same semantics as fetch(). "follow" (default) re-validates every hop. */
  redirect?: RequestRedirect;
  maxRedirects?: number;
  /**
   * Called for EVERY hop's response, with the URL that hop was sent to — used to
   * feed the cookie jar. The URL is passed explicitly because the jar scopes
   * cookies by host and must not have to infer it from the Response.
   */
  onResponse?: (res: Response, requestUrl: string) => void;
  /**
   * Per-hop Cookie header. Called with each hop's URL AFTER the gate has passed
   * it, so the jar decides what (if anything) is in scope for that specific
   * host. Returning "" sends no Cookie header. Supplying cookies this way rather
   * than in `headers` is what keeps a redirect to another host from inheriting
   * the previous host's session.
   */
  cookieHeaderFor?: (url: URL) => string;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  resolve?: ResolveFn;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function stripSensitive(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^(cookie|authorization|proxy-authorization)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Drop any caller-supplied Cookie header — the jar is the only authority. */
function stripCookieHeader(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^cookie$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function stripBodyHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^content-(length|type|encoding|language|location)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * fetch() with the SSRF gate applied to the initial URL AND to every redirect
 * hop. Redirects are followed by hand (`redirect: "manual"` under the hood) so
 * that no hop can escape validation — undici's own follower never calls back
 * into us.
 *
 * `redirect: "manual"` / `"error"` are passed through: the caller gets the 3xx
 * and drives the chain itself (ks.ts and ok.ts do this so their cookie jars see
 * every Set-Cookie). Those callers re-enter through request(), so their hops are
 * gated too.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  const max = opts.maxRedirects ?? 10;
  const mode = opts.redirect ?? "follow";

  let current = rawUrl;
  let method = (opts.method ?? "GET").toUpperCase();
  let body = opts.body;
  let headers: Record<string, string> = { ...(opts.headers ?? {}) };

  for (let hop = 0; hop <= max; hop++) {
    const { url } = await assertPublicUrlResolved(current, { resolve: opts.resolve });
    // Cookies are re-derived for THIS hop's host. Anything the caller put in
    // `headers` under a cookie name is dropped first, so the jar is the only
    // source of a Cookie header and no host can inherit another host's session.
    const hopHeaders = opts.cookieHeaderFor ? stripCookieHeader(headers) : { ...headers };
    if (opts.cookieHeaderFor) {
      const cookie = opts.cookieHeaderFor(url);
      if (cookie) hopHeaders["Cookie"] = cookie;
    }
    const res = await f(url.toString(), {
      method,
      headers: hopHeaders,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      redirect: "manual",
      signal: opts.signal,
    });
    opts.onResponse?.(res, url.toString());

    if (mode !== "follow") {
      if (mode === "error" && REDIRECT_STATUSES.has(res.status)) {
        throw new SsrfBlockedError(`unexpected redirect ${res.status} from ${url.toString()}`);
      }
      return res;
    }
    if (!REDIRECT_STATUSES.has(res.status)) return res;

    const loc = res.headers.get("location");
    if (!loc) return res; // 3xx without Location — hand it back like fetch does

    let next: URL;
    try {
      next = new URL(loc, url);
    } catch {
      throw new SsrfBlockedError(`invalid redirect target ${loc} from ${url.toString()}`);
    }
    await res.body?.cancel().catch(() => undefined);

    // Per the fetch spec: 303 always, and 301/302 for non-GET/HEAD, become GET.
    if (res.status === 303 || (method !== "GET" && method !== "HEAD" && (res.status === 301 || res.status === 302))) {
      method = "GET";
      body = undefined;
      headers = stripBodyHeaders(headers);
    }
    // Never carry credentials across an origin boundary chosen by a remote host.
    if (next.origin !== url.origin) headers = stripSensitive(headers);

    current = next.toString();
  }
  throw new SsrfBlockedError(`too many redirects (>${max}) starting at ${rawUrl}`);
}
