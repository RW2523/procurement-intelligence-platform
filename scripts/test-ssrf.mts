/**
 * SSRF gate tests (run: npx tsx scripts/test-ssrf.mts).
 *
 * Covers, in order:
 *   1. literal-address and reserved-name bypasses (IPv4-mapped IPv6, decimal /
 *      octal / hex IPv4, trailing dots, ULA/link-local IPv6, NAT64, 6to4)
 *   2. DNS rebinding — every resolved address must be public, not just the first
 *   3. redirect chains — EVERY hop is re-validated, not just the first
 *   4. request() / fetchText() / fetchJson() / fetchBuffer() are all gated
 *   5. a REAL listening socket on loopback standing in for the payroll app
 *   6. the real portal URLs from deploy/db/seed-sources.sql must still be ALLOWED
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
// Everything is imported through http.ts — the module the connectors actually
// use — so the SsrfBlockedError identity checked below is the same class the
// production call path throws.
import {
  assertPublicUrl,
  assertPublicUrlResolved,
  classifyIp,
  safeFetch,
  SsrfBlockedError,
  request,
  fetchText,
  fetchJson,
  fetchBuffer,
  CookieJar,
  type ResolveFn,
} from "../src/lib/connectors/http.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];

let sectionStart = 0;
let inSection = false;
function section(title: string) {
  if (inSection) console.log(`   ${pass + fail - sectionStart} checks`);
  sectionStart = pass + fail;
  inSection = true;
  console.log(`\n${title}`);
}

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function expectBlocked(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    check(name, false, "NOT BLOCKED — request would have been made");
  } catch (e) {
    const blocked = e instanceof SsrfBlockedError;
    check(name, blocked, blocked ? "" : `wrong error type: ${(e as Error).message}`);
  }
}

async function expectAllowed(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    check(name, true);
  } catch (e) {
    check(name, false, `BLOCKED but should be allowed: ${(e as Error).message}`);
  }
}

/** Deterministic resolver: every hostname is public unless mapped otherwise. */
function resolverFor(map: Record<string, string[]> = {}): ResolveFn {
  return async (host) => map[host] ?? ["203.0.113.10"];
}
const publicResolve = resolverFor();

// ── 1. Literal-address and reserved-name bypasses ────────────────────────────
section("1. literal addresses and reserved names");
const MUST_BLOCK_SYNC: [string, string][] = [
  ["http://169.254.169.254/latest/meta-data/", "EC2 IMDS (the original case)"],
  ["http://[::ffff:169.254.169.254]/latest/meta-data/", "IPv4-mapped IPv6 IMDS  <-- was a bypass"],
  ["http://[::ffff:a9fe:a9fe]/", "IPv4-mapped IMDS, hex form"],
  ["http://[::ffff:127.0.0.1]:3009/api/admin/export", "IPv4-mapped payroll loopback"],
  ["http://127.0.0.1:3009/api/admin/export", "payroll app on loopback"],
  ["http://[::1]:3009/api/admin/export", "payroll app over IPv6 loopback"],
  ["http://[0:0:0:0:0:0:0:1]/", "expanded IPv6 loopback"],
  ["http://[0000:0000:0000:0000:0000:0000:0000:0001]/", "fully expanded IPv6 loopback"],
  ["http://2852039166/", "decimal IPv4 for 169.254.169.254"],
  ["http://2130706433/", "decimal IPv4 for 127.0.0.1"],
  ["http://0177.0.0.1/", "octal IPv4 for 127.0.0.1"],
  ["http://0x7f.1/", "hex IPv4 for 127.0.0.1"],
  ["http://127.0.0.1./", "trailing-dot loopback"],
  ["http://169.254.169.254./", "trailing-dot IMDS"],
  ["http://localhost./", "trailing-dot localhost  <-- was a bypass"],
  ["http://LOCALHOST/", "uppercase localhost"],
  ["http://payroll.localhost/", ".localhost suffix"],
  ["http://metadata.google.internal/computeMetadata/v1/", "GCP metadata"],
  ["http://anything.internal/", ".internal suffix"],
  ["http://nas.local/", "mDNS .local"],
  ["http://[fd00::1]/", "IPv6 unique-local fd00::/7"],
  ["http://[fe80::1]/", "IPv6 link-local fe80::/10"],
  ["http://[fe80::1%25en0]/", "IPv6 link-local with zone id"],
  ["http://[64:ff9b::a9fe:a9fe]/", "NAT64-embedded IMDS"],
  ["http://[2002:a9fe:a9fe::]/", "6to4-embedded IMDS"],
  ["http://[::a9fe:a9fe]/", "IPv4-compatible IPv6 IMDS"],
  ["http://10.0.0.5/", "RFC1918 10/8"],
  ["http://172.16.0.1/", "RFC1918 172.16/12"],
  ["http://172.31.255.255/", "RFC1918 172.16/12 upper edge"],
  ["http://192.168.1.1/", "RFC1918 192.168/16"],
  ["http://100.64.0.1/", "carrier-grade NAT"],
  ["http://0.0.0.0/", "unspecified"],
  ["http://[::]/", "IPv6 unspecified"],
  ["http://255.255.255.255/", "broadcast"],
  ["http://224.0.0.1/", "multicast"],
  ["file:///etc/passwd", "file scheme"],
  ["gopher://169.254.169.254/", "gopher scheme"],
  ["http://evp.nc.gov@169.254.169.254/latest/meta-data/", "userinfo disguises the real host"],
];
for (const [url, why] of MUST_BLOCK_SYNC) {
  await expectBlocked(`block ${url}  (${why})`, () => assertPublicUrl(url));
}

// classifyIp is the shared primitive — spot-check it directly.
check("classifyIp 169.254.169.254 blocked", classifyIp("169.254.169.254") !== null);
check("classifyIp ::ffff:169.254.169.254 blocked", classifyIp("::ffff:169.254.169.254") !== null);
check("classifyIp 8.8.8.8 allowed", classifyIp("8.8.8.8") === null, String(classifyIp("8.8.8.8")));
check("classifyIp 2606:4700::1111 allowed", classifyIp("2606:4700::1111") === null, String(classifyIp("2606:4700::1111")));

// ── 2. DNS rebinding ─────────────────────────────────────────────────────────
section("2. DNS rebinding / resolved-address checks");
await expectBlocked("host resolving to IMDS is blocked", () =>
  assertPublicUrlResolved("http://portal.evil.example/doc.pdf", {
    resolve: resolverFor({ "portal.evil.example": ["169.254.169.254"] }),
  }),
);
await expectBlocked("host resolving to payroll loopback is blocked", () =>
  assertPublicUrlResolved("http://portal.evil.example/doc.pdf", {
    resolve: resolverFor({ "portal.evil.example": ["127.0.0.1"] }),
  }),
);
await expectBlocked("mixed public+private answer set is blocked (not just the first)", () =>
  assertPublicUrlResolved("http://portal.evil.example/doc.pdf", {
    resolve: resolverFor({ "portal.evil.example": ["93.184.216.34", "169.254.169.254"] }),
  }),
);
await expectBlocked("host resolving to IPv6 ULA is blocked", () =>
  assertPublicUrlResolved("http://portal.evil.example/", {
    resolve: resolverFor({ "portal.evil.example": ["fd00::1"] }),
  }),
);
await expectBlocked("host resolving to nothing is blocked", () =>
  assertPublicUrlResolved("http://portal.evil.example/", { resolve: async () => [] }),
);
await expectBlocked("unresolvable host is blocked", () =>
  assertPublicUrlResolved("http://portal.evil.example/", {
    resolve: async () => { throw new Error("ENOTFOUND"); },
  }),
);
await expectAllowed("host resolving to all-public answers is allowed", () =>
  assertPublicUrlResolved("http://evp.nc.gov/solicitations/", {
    resolve: resolverFor({ "evp.nc.gov": ["23.45.67.89", "2606:4700::1111"] }),
  }),
);

// ── 3. Redirect chains: every hop re-validated ───────────────────────────────
section("3. redirect chains");

/** Scripted portal: url -> Response. Records what was actually requested. */
function scriptedFetch(script: Record<string, () => Response>) {
  const seen: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    seen.push(u);
    const make = script[u];
    if (!make) throw new Error(`unscripted fetch of ${u} (method ${init?.method})`);
    return make();
  }) as unknown as typeof fetch;
  return { impl, seen };
}
const redirectTo = (loc: string, status = 302) =>
  new Response(null, { status, headers: { location: loc } });

{
  const { impl, seen } = scriptedFetch({
    "http://evil.example/redirect": () => redirectTo("http://169.254.169.254/latest/meta-data/"),
    "http://169.254.169.254/latest/meta-data/": () => new Response("IAM CREDENTIALS"),
  });
  await expectBlocked("redirect -> 169.254.169.254 blocked at hop 2", () =>
    safeFetch("http://evil.example/redirect", { fetchImpl: impl, resolve: publicResolve }),
  );
  check(
    "IMDS was never contacted",
    !seen.includes("http://169.254.169.254/latest/meta-data/"),
    `fetched: ${seen.join(", ")}`,
  );
}
{
  const { impl, seen } = scriptedFetch({
    "http://evil.example/r": () => redirectTo("http://[::ffff:169.254.169.254]/latest/meta-data/"),
  });
  await expectBlocked("redirect -> IPv4-mapped IMDS blocked at hop 2", () =>
    safeFetch("http://evil.example/r", { fetchImpl: impl, resolve: publicResolve }),
  );
  check("IPv4-mapped IMDS never contacted", seen.length === 1, `fetched: ${seen.join(", ")}`);
}
{
  const { impl, seen } = scriptedFetch({
    "http://evil.example/r": () => redirectTo("http://127.0.0.1:3009/api/admin/export"),
  });
  await expectBlocked("redirect -> payroll /api/admin/export blocked at hop 2", () =>
    safeFetch("http://evil.example/r", { fetchImpl: impl, resolve: publicResolve }),
  );
  check("payroll export never contacted", seen.length === 1, `fetched: ${seen.join(", ")}`);
}
{
  // Deep chain: the private target hides at hop 4.
  const { impl, seen } = scriptedFetch({
    "http://a.example/1": () => redirectTo("http://b.example/2"),
    "http://b.example/2": () => redirectTo("http://c.example/3"),
    "http://c.example/3": () => redirectTo("http://169.254.169.254/"),
  });
  await expectBlocked("4-hop chain ending at IMDS is blocked", () =>
    safeFetch("http://a.example/1", { fetchImpl: impl, resolve: publicResolve }),
  );
  check("deep chain stopped before IMDS", seen.length === 3, `fetched: ${seen.join(", ")}`);
}
{
  // Rebinding via redirect: hop 2 hostname is public-looking but resolves private.
  const { impl } = scriptedFetch({
    "http://a.example/1": () => redirectTo("http://rebind.example/2"),
  });
  await expectBlocked("redirect to host that RESOLVES private is blocked", () =>
    safeFetch("http://a.example/1", {
      fetchImpl: impl,
      resolve: resolverFor({ "rebind.example": ["169.254.169.254"] }),
    }),
  );
}
{
  // Must still work: a normal 302 between two public hosts.
  const { impl, seen } = scriptedFetch({
    "https://www.txsmartbuy.gov/esbd": () => redirectTo("https://www.txsmartbuy.gov/esbd/list"),
    "https://www.txsmartbuy.gov/esbd/list": () => new Response("<html>bids</html>", { status: 200 }),
  });
  const res = await safeFetch("https://www.txsmartbuy.gov/esbd", {
    fetchImpl: impl,
    resolve: publicResolve,
  });
  check("public -> public redirect is followed", res.status === 200, `status ${res.status}`);
  check("both public hops fetched", seen.length === 2, `fetched: ${seen.join(", ")}`);
  check("body survives the follow", (await res.text()) === "<html>bids</html>");
}
{
  // redirect:"manual" (ks.ts / ok.ts hand-rolled cookie chains) must be preserved.
  const { impl } = scriptedFetch({
    "https://supplier.sok.ks.gov/psc/x": () => redirectTo("https://supplier.sok.ks.gov/psc/y"),
  });
  const res = await safeFetch("https://supplier.sok.ks.gov/psc/x", {
    redirect: "manual",
    fetchImpl: impl,
    resolve: publicResolve,
  });
  check("redirect:manual returns the 3xx unfollowed", res.status === 302, `status ${res.status}`);
  check(
    "redirect:manual exposes Location for the caller",
    res.headers.get("location") === "https://supplier.sok.ks.gov/psc/y",
  );
}
{
  // ...and the caller's next hop is still gated when it re-enters the gate.
  await expectBlocked("manual-mode caller's next hop is gated on re-entry", () =>
    safeFetch("http://169.254.169.254/latest/meta-data/", {
      redirect: "manual",
      fetchImpl: scriptedFetch({}).impl,
      resolve: publicResolve,
    }),
  );
}
{
  const script: Record<string, () => Response> = {};
  for (let i = 0; i < 40; i++) {
    script[`http://a.example/${i}`] = () => redirectTo(`http://a.example/${i + 1}`);
  }
  const { impl, seen } = scriptedFetch(script);
  await expectBlocked("infinite redirect loop is capped", () =>
    safeFetch("http://a.example/0", { fetchImpl: impl, resolve: publicResolve }),
  );
  check("loop capped at maxRedirects+1 hops", seen.length === 11, `hops=${seen.length}`);
}
{
  // Credentials must not cross an origin boundary the remote host picked.
  let sawCookieOnHop2: string | null | undefined;
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const u = String(input);
    if (u === "https://portal.example/a") return redirectTo("https://evil.example/b");
    sawCookieOnHop2 = (init?.headers as Record<string, string>)?.Cookie;
    return new Response("ok");
  }) as unknown as typeof fetch;
  await safeFetch("https://portal.example/a", {
    headers: { Cookie: "SESSION=secret", "User-Agent": "bot" },
    fetchImpl: impl,
    resolve: publicResolve,
  });
  check("Cookie stripped on cross-origin redirect", sawCookieOnHop2 === undefined, String(sawCookieOnHop2));
}

// ── 4 & 5. Every exported fetch helper, against a REAL listening socket ──────
section("4/5. real loopback socket standing in for the payroll app");
let connections = 0;
let requests = 0;
const payroll = http.createServer((_req, res) => {
  requests++;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ secret: "PAYROLL_SSN_DUMP" }));
});
payroll.on("connection", () => { connections++; });
await new Promise<void>((r) => payroll.listen(0, "127.0.0.1", r));
const port = (payroll.address() as AddressInfo).port;
const payrollUrl = `http://127.0.0.1:${port}/api/admin/export`;

// Sanity: the server really is up and really would leak, with a plain fetch.
{
  const raw = await fetch(payrollUrl).then((r) => r.text());
  check("control: unguarded fetch DOES leak the payroll secret", raw.includes("PAYROLL_SSN_DUMP"), raw);
  check("control: the real server was really hit", requests === 1, `requests=${requests}`);
}
const baseline = { connections, requests };

await expectBlocked("request() blocked", () => request(payrollUrl));
await expectBlocked("fetchText() blocked", () => fetchText(payrollUrl));
await expectBlocked("fetchJson() blocked", () => fetchJson(payrollUrl));
await expectBlocked("fetchBuffer() blocked", () => fetchBuffer(payrollUrl));
await expectBlocked("request() blocked via IPv4-mapped form", () =>
  request(`http://[::ffff:127.0.0.1]:${port}/api/admin/export`),
);
await expectBlocked("fetchText() blocked via decimal IPv4", () =>
  fetchText(`http://2130706433:${port}/api/admin/export`),
);
await expectBlocked("fetchBuffer() blocked via trailing-dot localhost", () =>
  fetchBuffer(`http://localhost.:${port}/api/admin/export`),
);
check(
  "the payroll socket was never opened by any guarded helper",
  connections === baseline.connections && requests === baseline.requests,
  `connections ${baseline.connections}->${connections}, requests ${baseline.requests}->${requests}`,
);

// A REAL 302 produced by a REAL server, pointing at the metadata service.
const redirector = http.createServer((_req, res) => {
  res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" });
  res.end();
});
await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
const redirPort = (redirector.address() as AddressInfo).port;
{
  // Prove the 302 is genuine and that a naive client follows it off-box.
  const real = await fetch(`http://127.0.0.1:${redirPort}/r`, { redirect: "manual" });
  check("control: real server emits a real 302 to IMDS", real.status === 302, `status ${real.status}`);
  const loc = real.headers.get("location")!;
  // Replay that genuine hop-1 response through safeFetch: hop 2 must be refused.
  const impl = (async (input: string | URL) => {
    if (String(input) === "http://portal.example/r") return redirectTo(loc);
    return new Response("IAM CREDENTIALS LEAKED");
  }) as unknown as typeof fetch;
  await expectBlocked("server-produced 302 to IMDS is refused at hop 2", () =>
    safeFetch("http://portal.example/r", { fetchImpl: impl, resolve: publicResolve }),
  );
}

payroll.close();
redirector.close();

// ── 6. Real portal URLs from deploy/db/seed-sources.sql must still be ALLOWED ─
section("6. real portal URLs must still be allowed (crawler not broken)");
const SEED_URLS = [
  "https://bids.sciquest.com/apps/Router/PublicEvent?CustomerOrg=StateOfMontana",
  "https://evp.nc.gov/solicitations/?status=0",
  "https://ewqg.fa.us8.oraclecloud.com/fscmUI/redwood/negotiation-abstracts/view/abstractlisting?prcBuId=300000005255687",
  "https://financials.ok.gov/psc/SOKLFP1DS/SUPPLIER/ERP/c/SCP_PUBLIC_MENU_FL.SCP_PUB_BID_CMP_FL.GBL",
  "https://iris-vss.alaska.gov/",
  "https://procurement.opengov.com/portal/phoenix",
  "https://public.ndbuys.nd.gov/page.aspx/en/rfp/request_browse_public",
  "https://sam.gov/",
  "https://supplier.sok.ks.gov/psc/sokfsprdsup/SUPPLIER/ERP/c/SCP_PUBLIC_MENU_FL.SCP_PUB_BID_CMP_FL.GBL",
  "https://vss.ky.gov/vssprod-ext/Advantage4",
  "https://www.arkansas.gov/tss/procurement/bids/index.php",
  "https://www.commbuys.com/bso/view/search/external/advancedSearchBid.xhtml?openBids=true",
  "https://www.dfa.ms.gov/bids-and-rfps-notices",
  "https://www.emarketplace.state.pa.us/Search.aspx",
  "https://www.publicpurchase.com/gems/wyominggsd",
  "https://www.sd.gov/bhra?id=cs_kb_article_view&sysparm_article=KB0044787",
  "https://www.state.wv.us/admin/purchase/Awards/awarded.html",
  "https://www.tn.gov/content/tn/generalservices/procurement/central-procurement-office--cpo-/supplier-information/request-for-proposals--rfp--opportunities1.html",
  "https://www.txsmartbuy.gov/browsecontracts",
  "https://www.txsmartbuy.gov/esbd",
  "https://wwwcfprd.doa.louisiana.gov/osp/lapac/deptbids.cfm",
];
for (const u of SEED_URLS) {
  await expectAllowed(`allow ${u}`, () => assertPublicUrlResolved(u, { resolve: publicResolve }));
}
// Typical scraped attachment URLs must survive too.
for (const u of [
  "https://www.commbuys.com/bso/external/bidDetail.sdo?docId=BD-25-1080&fileDownload=1",
  "http://wwwcfprd.doa.louisiana.gov/osp/lapac/getdocument.cfm?doc=12345.pdf",
  "https://s3.amazonaws.com/opengov-attachments/scope-of-work.pdf",
]) {
  await expectAllowed(`allow attachment ${u}`, () =>
    assertPublicUrlResolved(u, { resolve: publicResolve }),
  );
}

// ── 7. Cookie jar scoping ────────────────────────────────────────────────────
// The URL gate is not the only thing a hostile portal can attack: it also
// controls the URLs we fetch NEXT (attachments.ts scrapes them out of the page
// it serves). A jar seeded from that portal must not hand its session cookie to
// whatever host those scraped links name. No redirect is involved on that first
// request, so safeFetch's cross-origin stripping never fires — the scope check
// has to live in the jar itself.
section("7. cookie jar is scoped to the host that set the cookie");

/** Build a jar holding cookies as if `url` had returned them. */
function jarFrom(url: string, ...setCookie: string[]): CookieJar {
  const j = new CookieJar();
  j.ingest(new Response("", { headers: setCookie.map((v) => ["set-cookie", v] as [string, string]) }), url);
  return j;
}

{
  const j = jarFrom("https://evp.nc.gov/solicitations/?id=1", "PORTALSESS=nc-secret; Path=/");
  check("session replays to the host that set it", j.header("https://evp.nc.gov/_services/x").includes("PORTALSESS=nc-secret"));
  check("session withheld from an unrelated host", j.header("https://evil.example/doc.pdf") === "", j.header("https://evil.example/doc.pdf"));
  check("session withheld from a superstring host", j.header("https://evp.nc.gov.evil.example/x") === "");
  check("host-only cookie withheld from a sibling subdomain", j.header("https://other.nc.gov/x") === "");
  check("trailing-dot form of the same host still matches", j.header("https://evp.nc.gov./x").includes("PORTALSESS"));
}
{
  const j = jarFrom("https://evp.nc.gov/x", "WIDE=w; Domain=.nc.gov");
  check("Domain=.nc.gov reaches a sibling nc.gov host", j.header("https://other.nc.gov/x").includes("WIDE=w"));
  check("Domain=.nc.gov does not reach a host merely ENDING in nc.gov", j.header("https://notnc.gov/x") === "");
  check("Domain=.nc.gov does not reach an unrelated host", j.header("https://evil.example/x") === "");
}
{
  const j = jarFrom("https://evp.nc.gov/x", "T=t; Domain=gov", "F=f; Domain=evil.example");
  check("Domain=<bare TLD> is not honoured", j.header("https://www.irs.gov/x") === "", j.header("https://www.irs.gov/x"));
  check("Domain=<unrelated host> is not honoured", j.header("https://evil.example/x") === "", j.header("https://evil.example/x"));
}
{
  const j = jarFrom("https://portal.example/x", "S=sec; Secure", "P=plain");
  check("Secure cookie withheld over http", !j.header("http://portal.example/x").includes("S=sec"));
  check("non-Secure cookie still sent over http", j.header("http://portal.example/x").includes("P=plain"));
  check("Secure cookie sent over https", j.header("https://portal.example/x").includes("S=sec"));
}
{
  const j = new CookieJar();
  j.ingest(new Response("", { headers: { "set-cookie": "X=1" } }));
  check("Set-Cookie with no known origin is dropped, not guessed", j.size === 0, `size=${j.size}`);
}

// End-to-end through the real request()/fetchBuffer(), against a REAL server.
// Public IP LITERALS are used as the two "hosts" so the gate skips DNS entirely
// and the test stays offline-deterministic; the transport is pointed at loopback
// while each helper still believes it is talking to a public address.
{
  const PORTAL = "203.0.113.9"; // TEST-NET-3 — classified public, never resolved
  const OTHER = "198.51.100.7"; // TEST-NET-2
  const hits: Array<{ host: string; cookie: string | undefined }> = [];
  const srv = http.createServer((q, res) => {
    const host = (q.headers["x-intended-host"] as string) ?? "";
    hits.push({ host, cookie: q.headers.cookie });
    // ONLY the portal issues a session. If the foreign host also set this
    // cookie, its own cookie coming back would look exactly like a leak.
    res.writeHead(200, host === PORTAL ? { "set-cookie": "PORTALSESS=nc-secret; Path=/" } : {});
    res.end("<html>ok</html>");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const p = (srv.address() as AddressInfo).port;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input instanceof URL ? input.href : typeof input === "string" ? input : (input as Request).url));
    const h = new Headers(init?.headers as HeadersInit);
    h.set("x-intended-host", u.hostname);
    return realFetch(new URL(u.pathname + u.search, `http://127.0.0.1:${p}`).href, { ...init, headers: h });
  }) as typeof fetch;
  try {
    const jar = new CookieJar();
    await request(`http://${PORTAL}/detail`, { jar, timeoutMs: 5000 });
    check("control: the portal really set a session cookie", jar.size === 1, `size=${jar.size}`);

    await request(`http://${OTHER}/scraped-doc.pdf`, { jar, timeoutMs: 5000 });
    check(
      "request(): portal cookie NOT sent to a scraped foreign host",
      !(hits[hits.length - 1].cookie ?? "").includes("nc-secret"),
      `cookie=${hits[hits.length - 1].cookie}`,
    );
    await fetchBuffer(`http://${OTHER}/scraped-doc.pdf`, { jar, timeoutMs: 5000 });
    check(
      "fetchBuffer(): portal cookie NOT sent to a scraped foreign host",
      !(hits[hits.length - 1].cookie ?? "").includes("nc-secret"),
      `cookie=${hits[hits.length - 1].cookie}`,
    );
    // ...and the jar must still do its actual job.
    await request(`http://${PORTAL}/attachment`, { jar, timeoutMs: 5000 });
    check(
      "request(): portal cookie IS replayed to the portal",
      (hits[hits.length - 1].cookie ?? "").includes("nc-secret"),
      `cookie=${hits[hits.length - 1].cookie}`,
    );
    await fetchBuffer(`http://${PORTAL}/attachment`, { jar, timeoutMs: 5000 });
    check(
      "fetchBuffer(): portal cookie IS replayed to the portal",
      (hits[hits.length - 1].cookie ?? "").includes("nc-secret"),
      `cookie=${hits[hits.length - 1].cookie}`,
    );
  } finally {
    globalThis.fetch = realFetch;
    srv.close();
  }
}
{
  // A redirect the remote host chooses must not carry the jar off-origin either.
  const jar = jarFrom("https://portal.example/a", "SESS=secret");
  let hop2Cookie: string | null | undefined;
  const impl = (async (input: string | URL, init?: RequestInit) => {
    if (String(input) === "https://portal.example/a") return redirectTo("https://evil.example/b");
    hop2Cookie = (init?.headers as Record<string, string>)?.Cookie;
    return new Response("ok");
  }) as unknown as typeof fetch;
  await safeFetch("https://portal.example/a", {
    fetchImpl: impl,
    resolve: publicResolve,
    cookieHeaderFor: (u) => jar.header(u.toString()),
  });
  check("jar cookie not carried across a redirect to another host", hop2Cookie === undefined, String(hop2Cookie));
}

// Live DNS smoke test — informational, never fails the suite (CI may be offline).
try {
  await assertPublicUrlResolved("https://sam.gov/");
  console.log("  (live DNS) https://sam.gov/ resolves public — OK");
} catch (e) {
  console.log(`  (live DNS) skipped: ${(e as Error).message}`);
}

console.log(`   ${pass + fail - sectionStart} checks`);
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
