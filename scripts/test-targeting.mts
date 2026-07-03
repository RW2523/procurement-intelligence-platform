/**
 * Golden-set tests for the targeting engine (run: npx tsx scripts/test-targeting.mts).
 * Uses relative imports + type-only aliases so it runs without the Next.js toolchain.
 */
import { scoreOpportunity, urgencyFor, phraseRegex } from "../src/lib/targeting/engine.ts";
import { DEFAULT_TARGETING_PROFILE as P } from "../src/lib/targeting/defaults.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

// ── 1. High-fit IT modernization + set-aside → PURSUE ────────────────────────
{
  const r = scoreOpportunity(
    {
      title: "RFP: IT Modernization and Application Development for Case Management",
      description:
        "Agency seeks legacy system modernization, custom software development, cloud migration to Azure, " +
        "program management office support, cybersecurity continuous monitoring, " +
        "and data analytics dashboards in Power BI. This is an 8(a) set-aside under GSA MAS. NAICS 541512.",
      naicsCode: "541512",
      dueDate: days(30),
      sourceState: "PA",
    },
    P,
  );
  check("pursue: bucket", r.bucket === "PURSUE", `got ${r.bucket} score=${r.pursuitScore}`);
  check("pursue: score >= 80", r.pursuitScore >= 80, `got ${r.pursuitScore}`);
  check("pursue: urgency STANDARD (30d)", r.urgency === "STANDARD", r.urgency);
  check("pursue: set-aside detected", r.setAsides.some((s) => s.includes("8(a)")), r.setAsides.join(","));
  check("pursue: GSA MAS vehicle", r.contractVehicle === "GSA MAS", String(r.contractVehicle));
  check("pursue: solicitation type RFP", r.solicitationType === "RFP", String(r.solicitationType));
  check("pursue: state points (PA)", r.breakdown.some((b) => b.criterion.startsWith("State government")), "");
}

// ── 2. Pure construction → excluded → IGNORE ─────────────────────────────────
{
  const r = scoreOpportunity(
    { title: "Roofing Replacement and HVAC Upgrades, District Office", description: "Roofing, plumbing and paving work.", dueDate: days(30) },
    P,
  );
  check("construction: IGNORE", r.bucket === "IGNORE", r.bucket);
  check("construction: excludedReason set", !!r.excludedReason, String(r.excludedReason));
}

// ── 3. Exclusion override: IT signal beats exclude keyword ───────────────────
{
  const r = scoreOpportunity(
    {
      title: "IT Modernization of HVAC Monitoring Systems",
      description: "Software development for building automation data integration and dashboards.",
      dueDate: days(30),
    },
    P,
  );
  check("override: not excluded", r.excludedReason === null, String(r.excludedReason));
  check("override: capability points kept", r.pursuitScore >= 20, String(r.pursuitScore));
  check("override: noted in breakdown", r.breakdown.some((b) => b.criterion.startsWith("Exclusion overridden")), "");
}

// ── 4. AI word-boundary: 'maintenance'/'retail' must NOT fire AI ─────────────
{
  const r = scoreOpportunity(
    { title: "Building maintenance and retail supplies", description: "Janitorial detail work daily.", dueDate: days(30) },
    P,
  );
  check("ai-boundary: AI not matched", !r.breakdown.some((b) => b.criterion === "AI"), JSON.stringify(r.breakdown));
  const r2 = scoreOpportunity({ title: "AI Enablement Services", description: "Deploy generative AI.", dueDate: days(30) }, P);
  check("ai-boundary: real AI matched", r2.breakdown.some((b) => b.criterion === "AI"), "");
}

// ── 5. DoD IT-only rule ──────────────────────────────────────────────────────
{
  const noIT = scoreOpportunity(
    { title: "Sources Sought: Grounds mowing services", agency: "Department of Defense", dueDate: days(30) },
    P,
  );
  check("dod: no agency points without IT", !noIT.breakdown.some((b) => b.criterion.startsWith("Federal agency: DoD")), "");
  const withIT = scoreOpportunity(
    { title: "DevSecOps and Cloud Engineering support", agency: "Department of Defense", dueDate: days(30) },
    P,
  );
  check("dod: agency points with IT", withIT.breakdown.some((b) => b.criterion === "Federal agency: DoD"), "");
}

// ── 6. Labor-category-only solicitation still scores its parent group ────────
{
  const r = scoreOpportunity(
    { title: "Staff Augmentation: two Full Stack Developers and a QA Analyst", dueDate: days(30) },
    P,
  );
  check("labor: Application Development fired", r.breakdown.some((b) => b.criterion === "Application Development"), "");
}

// ── 7. Technology-only: C# / .NET / Node.js symbol matching ──────────────────
{
  const r = scoreOpportunity(
    { title: "Enhancement of case portal", description: "Stack: C#, .NET, Node.js, PostgreSQL.", dueDate: days(30) },
    P,
  );
  check("tech: AppDev via C#/.NET", r.breakdown.some((b) => b.criterion === "Application Development"), "");
  check("tech: Data via PostgreSQL", r.breakdown.some((b) => b.criterion === "Data Analytics"), "");
}

// ── 8. Functional-area-only ──────────────────────────────────────────────────
{
  const r = scoreOpportunity({ title: "Mission Support and Technical Assistance Services", dueDate: days(30) }, P);
  check("functional: fired", r.breakdown.some((b) => b.criterion === "Functional area"), "");
}

// ── 9. Date bands: 9/10/20/21/45/46 boundaries (§10) ─────────────────────────
{
  check("date: 9d INSUFFICIENT", urgencyFor(days(9), P.dateBands) === "INSUFFICIENT_TIME", urgencyFor(days(9), P.dateBands));
  check("date: 10d URGENT", urgencyFor(days(10), P.dateBands) === "URGENT", urgencyFor(days(10), P.dateBands));
  check("date: 20d URGENT", urgencyFor(days(20), P.dateBands) === "URGENT", urgencyFor(days(20), P.dateBands));
  check("date: 21d STANDARD", urgencyFor(days(21), P.dateBands) === "STANDARD", urgencyFor(days(21), P.dateBands));
  check("date: 45d STANDARD", urgencyFor(days(45), P.dateBands) === "STANDARD", urgencyFor(days(45), P.dateBands));
  check("date: 46d EARLY_CAPTURE", urgencyFor(days(46), P.dateBands) === "EARLY_CAPTURE", urgencyFor(days(46), P.dateBands));
  check("date: null NO_DATE", urgencyFor(null, P.dateBands) === "NO_DATE", "");
}

// ── 10. Thresholds: capture-review and manual-review bands ───────────────────
{
  const capture = scoreOpportunity(
    {
      title: "RFP: Application Development and Data Analytics Platform",
      description:
        "Custom software development with cloud hosting on AWS; program management office support. " +
        "8(a) set-aside. NAICS 541511.",
      naicsCode: "541511",
      dueDate: days(30),
    },
    P,
  ); // appdev 10 + data 9 + cloud 8 + pm 9 + 8(a) 10 + naics 6 + rfp 2 = 54... plus functional/etc → 60s band
  check(
    "capture: CAPTURE_REVIEW or MANUAL band, not IGNORE",
    capture.bucket === "CAPTURE_REVIEW" || capture.bucket === "MANUAL_REVIEW" || capture.bucket === "PURSUE",
    `${capture.bucket} ${capture.pursuitScore}`,
  );
  const manual = scoreOpportunity(
    { title: "Help Desk staffing", description: "Tier 1 and Tier 2 help desk support.", dueDate: days(30) },
    P,
  ); // service desk 7 + ... below 60
  check("manual: below 60", manual.pursuitScore < 60, String(manual.pursuitScore));
}

// ── 11. Sole Source / Direct Award boost ─────────────────────────────────────
{
  const r = scoreOpportunity(
    { title: "8(a) Sole Source: Data Analytics Platform Support", description: "Direct award to an 8(a) firm for dashboard development.", dueDate: days(30) },
    P,
  );
  check("solesource: detected", r.setAsides.some((s) => s.includes("Sole Source")), r.setAsides.join(","));
  check("solesource: 8(a) detected too", r.setAsides.some((s) => s.includes("8(a)")), r.setAsides.join(","));
}

// ── 12. General 'Small Business' does not double-fire with specific set-aside ─
{
  const r = scoreOpportunity(
    { title: "WOSB set-aside: small business IT support services", dueDate: days(30) },
    P,
  );
  const generals = r.setAsides.filter((s) => s.startsWith("Small Business (general)"));
  check("general-sb: suppressed when specific tier fired", generals.length === 0, r.setAsides.join(","));
}

// ── 13. phraseRegex sanity on symbol terms ───────────────────────────────────
{
  check("regex: C# matches", phraseRegex("C#").re.test("built in C# and SQL"), "");
  check("regex: .NET matches", phraseRegex(".NET").re.test("a .NET modernization"), "");
  check("regex: 8(a) matches", phraseRegex("8(a)").re.test("8(a) set-aside"), "");
  check("regex: SOC not in 'associates'", !phraseRegex("SOC").re.test("associates degree"), "");
  check("regex: ETL not in 'shuttle'", !phraseRegex("ETL").re.test("shuttle services"), "");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
