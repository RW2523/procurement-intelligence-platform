/**
 * Regression suite for the department matcher
 * (run: npx tsx scripts/test-departments.mts).
 *
 * Same shape as scripts/test-targeting.mts: relative imports, no Next.js
 * toolchain, exit code 1 on any failure so CI can gate on it.
 *
 * SECTION 20 IS THE ONE THAT MATTERS. It runs every one of the 71 "Agency/POC"
 * cells from the user's real Pipeline_2026 sheet (captured verbatim in
 * scripts/fixtures/pipeline-2026-rows.json) through matchDepartment(), and every
 * (agency, description) pair through departmentForOpportunity(), and asserts an
 * expected department for each. A matcher that has not been run against that
 * sheet is not finished: a false NEGATIVE makes the user's own work invisible in
 * the department filter they asked for, and a false POSITIVE files it under a
 * department it has nothing to do with.
 *
 * Sections 1-19 are the unit cases, including every case from the verification
 * findings. Where a case's correct answer is genuinely debatable, the choice is
 * stated in a comment next to it.
 *
 * CONTACT DETAILS IN THIS FILE ARE SYNTHETIC — KEEP THEM THAT WAY. The unit
 * cases are modelled on real sheet rows, but every personal name, mailbox
 * local part and desk phone number here is invented. Only the parts the
 * matcher actually reads are real: the DOMAIN (`@dot.gov`, `@ibc.doi.gov`,
 * `@schools.nyc.gov`, `@danvilleva.gov`, …), the glued-acronym shape of
 * `FHWASmallBusiness@`, published org mailboxes, published office addresses
 * and the public GSA hotline. No assertion depends on a personal local part
 * or on a person's name, so substituting them costs the suite nothing.
 * The real POC blocks live only in scripts/fixtures/pipeline-2026-rows.json,
 * which is gitignored for exactly this reason (see .gitignore) — do not copy
 * values out of the fixture into this file, into src/lib/departments.ts
 * comments, or into docs/PIPELINE-2026.md.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  matchDepartment,
  matchDepartmentDetail,
  departmentForOpportunity,
  stripPostalAddresses,
  isJurisdictionOwnedAcronym,
  isPriorityDepartment,
  DEPARTMENT_CODES,
  type DepartmentCode,
} from "../src/lib/departments.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
  } else {
    fail++;
    const line = `  ✗ ${name}${detail ? ` — got ${detail}` : ""}`;
    failures.push(line);
    console.error(line);
  }
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
}
/** Table driver: [text, expected] pairs through matchDepartment(). */
function table(label: string, cases: ReadonlyArray<readonly [string, DepartmentCode | null]>) {
  for (const [text, expected] of cases) {
    eq(`${label}: ${JSON.stringify(text.length > 64 ? text.slice(0, 61) + "…" : text)}`,
      matchDepartment(text), expected);
  }
}

// ── 1. THE THREE CASES FROM THE USER'S OWN DATA ──────────────────────────────
{
  // (a) Interior, with a Virginia postal address in the POC block.
  const doi =
    "The U.S. Department of the Interior\n381 ELDEN STREET, SUITE 4000\n" +
    "Herndon, VA 20170\nMARGUERITE RODRIGUEZ\nmarguerite_rodriguez@ibc.doi.gov\n703-555-0142";
  eq("(a) Interior POC block → DOI", matchDepartment(doi), "DOI");
  check("(a) matched on the full name, not an acronym", matchDepartmentDetail(doi)?.via === "full-name",
    String(matchDepartmentDetail(doi)?.via));
  check("(a) did NOT read the Virginia postal code as Veterans Affairs",
    matchDepartment(doi) !== "VA", String(matchDepartment(doi)));

  // (b) department/sub-agency notation
  eq("(b) 'DOT/FAA' → DOT", matchDepartment("DOT/FAA"), "DOT");

  // (c) an unrelated university
  eq("(c) CUNY → null",
    matchDepartment("City University of New York (CUNY), Office of Procurement, 205 East 42nd Street, New York, NY 10017"),
    null);
}

// ── 2. Postal-address stripping ──────────────────────────────────────────────
{
  check("strip: ', VA 20170' removed", !/VA/.test(stripPostalAddresses("Herndon, VA 20170")),
    stripPostalAddresses("Herndon, VA 20170"));
  check("strip: ZIP+4 removed", !/VA/.test(stripPostalAddresses("Herndon, VA 20170-4817")),
    stripPostalAddresses("Herndon, VA 20170-4817"));
  check("strip: no-comma form removed", !/VA/.test(stripPostalAddresses("Arlington VA 22202")),
    stripPostalAddresses("Arlington VA 22202"));
  // A bare ", VA" must SURVIVE stripping — it is often the department itself.
  check("strip: ', VA' with no ZIP is left alone", /VA/.test(stripPostalAddresses("Office of Information Technology, VA")),
    stripPostalAddresses("Office of Information Technology, VA"));
  table("addr", [
    ["Herndon, VA 20170", null],
    ["Purchasing Office, Richmond, VA", null],
    ["1849 C Street NW, Washington, DC 20240", null],
  ]);
}

// ── 2b. DEFECT [4] — the CITY must be stripped, not just the code and ZIP ────
//
// Taking "…, DC 20590" off "Washington, DC 20590" used to leave the bare word
// "Washington", which is in US_STATE_NAMES. The jurisdiction guard then vetoed
// whatever federal acronym or name the address block was introducing, and the
// row returned null — the damaging direction, because the operator's row
// silently disappears from the department filter they asked for.
//
// Washington/DC is the most likely instance (it is the seat of every federal
// department), but the shape is general: any leftover city name that is also a
// state name, or that ends in "City", trips a different clause of the same
// guard.
{
  const gone = (addr: string, leftover: RegExp) => {
    const out = stripPostalAddresses(addr);
    check(`strip: ${JSON.stringify(addr)} leaves no jurisdiction token`, !leftover.test(out), JSON.stringify(out));
  };
  gone("Washington, DC 20590", /Washington|DC|20590/);
  gone("Washington, D.C. 20590", /Washington|D\.?C|20590/);
  gone("Washington DC 20590", /Washington|DC|20590/);
  gone("WASHINGTON, DC 20590", /WASHINGTON|DC|20590/i);
  gone("Washington, DC 20590-0001", /Washington|DC|20590/);
  gone("Kansas City, MO 64106", /Kansas|City|MO|64106/);
  gone("Oklahoma City, OK 73102", /Oklahoma|City|OK|73102/);
  gone("New York, NY 10001", /New York|NY|10001/);
  gone("Jefferson City, MO 65101", /Jefferson|City|MO|65101/);
  gone("Salt Lake City, UT 84111", /Salt|Lake|City|UT|84111/);
  gone("Winston-Salem, NC 27101", /Winston|Salem|NC|27101/);
  // Mid-line: the street number and name are not part of the city slot.
  check("strip: street survives, city does not",
    stripPostalAddresses("1849 C Street NW, Washington, DC 20240").includes("1849 C Street NW") &&
      !/Washington/.test(stripPostalAddresses("1849 C Street NW, Washington, DC 20240")),
    JSON.stringify(stripPostalAddresses("1849 C Street NW, Washington, DC 20240")));

  // …and the guard the leftover used to trip now sees nothing.
  check("guard: nothing survives a DC address to veto the acronym",
    !isJurisdictionOwnedAcronym(stripPostalAddresses("Washington, DC 20590\n")),
    stripPostalAddresses("Washington, DC 20590\n"));

  // THE BUG, in the five shapes the operator's own POC blocks take. Every one
  // of these returned null before.
  table("DC address before the department", [
    ["Washington, DC 20590\nDOT", "DOT"],
    ["Washington, DC 20590 DOT", "DOT"],
    ["Washington, DC 20590\nDepartment of Transportation", "DOT"],
    ["Washington, DC 20590 Department of Transportation", "DOT"],
    ["Washington, D.C. 20590\nDOT", "DOT"],
    ["Washington DC 20590\nDOT", "DOT"],
    ["WASHINGTON, DC 20590\nDOT", "DOT"],
    // A "Washington, DC" line with no ZIP at all is still an address line.
    ["Washington, D.C.\nDOT", "DOT"],
    ["Washington, DC\nDepartment of Transportation", "DOT"],
    // The other four priority departments are all headquartered there too.
    ["Washington, DC 20420\nVA", "VA"],
    ["Washington, DC 20240\nDOI", "DOI"],
    ["Washington, DC 20201\nHHS", "HHS"],
    ["Washington, DC 20585\nDOE", "DOE"],
    ["Washington, DC 20240\nDepartment of the Interior", "DOI"],
  ]);

  // The same class of failure for cities that are also state names, or that end
  // in the word "City".
  table("state-name / '… City' address before the department", [
    ["Kansas City, MO 64106\nDOT", "DOT"],
    ["Oklahoma City, OK 73102\nDOT", "DOT"],
    ["New York, NY 10001\nDOT", "DOT"],
    ["Jefferson City, MO 65101\nDOT", "DOT"],
    ["Salt Lake City, UT 84111\nDOI", "DOI"],
    // A CHOSEN reading, stated here so it is not changed by accident: a city in
    // a POSTAL ADDRESS names a location, not an owner. The owner form — the city
    // sitting in front of the department's name — is a different string and is
    // still rejected two tables below.
    ["Vancouver, WA 98660\nDOT", "DOT"],
  ]);

  // The standard federal layout (organisation first) never regressed; keep it.
  table("DC address AFTER the department still resolves", [
    ["U.S. Department of Transportation\n1200 New Jersey Ave SE\nWashington, DC 20590\nJane Doe", "DOT"],
    ["Department of Veterans Affairs\n810 Vermont Ave NW\nWashington, DC 20420\nJohn Smith", "VA"],
    ["DOT/FAA\n800 Independence Ave SW\nWashington, DC 20591", "DOT"],
  ]);

  // THE FALSE-POSITIVE DIRECTION. Stripping the city must not delete a genuine
  // jurisdiction: a state or city that OWNS the department is written in front
  // of its name, not inside a postal line, and all of these stay null.
  table("stripping the city does not federalise a state or local body", [
    ["Washington State Department of Transportation\nOlympia, WA 98501\nWSDOT", null],
    ["Washington State DOT", null],
    ["Washington DOT", null],
    ["Virginia Department of Transportation\nRichmond, VA 23219\nDOT coordination", null],
    ["Minnesota Department of Transportation\nSaint Paul, MN 55155\nMn/DOT", null],
    ["New York State Department of Transportation\nAlbany, NY 12232", null],
    ["Kansas City Department of Transportation\nKansas City, MO 64106", null],
    ["Chicago Department of Transportation, Chicago, IL 60602", null],
    ["City of Austin\nAustin, TX 78701\nDOT paving", null],
    ["County of Orange\n300 N Flower St\nSanta Ana, CA 92703\nDOT paving RFP", null],
    ["Nassau County\nDepartment of Public Works\nMineola, NY 11501\nDOT coordination", null],
  ]);

  // AN ORGANISATION IS NOT A CITY. "Federal Highway Administration, DC 20590"
  // fits the address shape exactly — line start, three capitalised words, code,
  // ZIP — and eating it would delete the name that identifies the row. Only the
  // code and the ZIP come off, exactly as before this fix.
  check("strip: an org name in the city slot is kept",
    stripPostalAddresses("Federal Highway Administration, DC 20590").includes("Federal Highway Administration"),
    JSON.stringify(stripPostalAddresses("Federal Highway Administration, DC 20590")));
  table("org name in the city slot keeps its department", [
    ["Federal Highway Administration, DC 20590\nnotice", "DOT"],
    ["Veterans Affairs, VA 20420\nsolicitation", "VA"],
    ["FEDERAL ACQUISITION SERVICE\nBoston, MA 02222\nDOI secure AI assistant", "DOI"],
  ]);

  // THE DELIBERATE LIMIT. No ZIP means no address strip — a bare ", VA" is
  // the department far more often than it is Virginia, and acceptVA() owns that
  // decision. DC is the one exception, because "Washington, DC" is never a
  // department reference.
  check("strip: '<city>, ST' with no ZIP is still left alone",
    stripPostalAddresses("Herndon, VA") === "Herndon, VA",
    JSON.stringify(stripPostalAddresses("Herndon, VA")));
  table("no-ZIP forms keep their existing answers", [
    ["Purchasing Office, Richmond, VA", null],
    ["Office of Information Technology, VA", "VA"],
    ["Washington DC VA Medical Center", "VA"],
  ]);
}

// ── 3. Veterans Affairs — the ambiguous acronym, both directions ─────────────
{
  table("VA accept", [
    ["VA", "VA"],
    ["VA Great Lakes Acquisition Center", "VA"],
    ["Department of Veterans Affairs", "VA"],
    ["Veterans Health Administration (VHA)", "VA"],
    ["VA/OI&T", "VA"],
    ["VA Medical Center, Durham", "VA"],
    // An ORG word before the comma, not a city: this is the department.
    ["Contracting Office, VA — serving veterans in region 4", "VA"],
    ["Office of Information Technology, VA", "VA"],
    // VA is exempt from the jurisdiction guard when — and only when — its own
    // veterans-specific evidence fired. These are real federal facilities.
    ["Washington DC VA Medical Center", "VA"],
    ["Maryland VA Health Care System, veterans outpatient clinic", "VA"],
    ["Veterans Canteen Service", "VA"],
  ]);
  eq("VA: slash notation 'HHS/VA' resolves to the FIRST named dept", matchDepartment("HHS/VA joint program"), "HHS");

  // FINDING #9 — acceptVA() leaked on exactly the class it was written to stop.
  // All twelve of these used to return VA.
  table("VA reject (finding #9)", [
    ["Sentara Norfolk General Hospital, 600 Gresham Dr, Norfolk, VA - Level I Trauma Medical Center", null],
    ["University of Virginia Medical Center, Charlottesville, VA", null],
    ["Bon Secours, Richmond, VA - St. Mary's Medical Center", null],
    ["City of Chesapeake, VA - study on housing for homeless veterans", null],
    ["Fairfax County, VA - Veterans Services Office", null],
    // A STATE department of veterans services is not the federal department.
    ["Virginia Department of Veterans Services, Richmond, VA", null],
    ["VA Beach City Public Schools", null],
    ["VA - Virginia statewide contract", null],
    ["VA, MD, DC metro area", null],
    ["Ship to: VA / NC / SC", null],
    ["MD/VA/DC region", null],
    // "VA DOT" is Virginia DOT: neither Veterans Affairs nor the federal DOT.
    ["VA DOT", null],
  ]);
  table("VA reject (pre-existing)", [
    ["Acme Solutions LLC, Reston, VA", null],
    ["procurement portal at somewhere-va.example.org", null],
    ["Commonwealth of Virginia, Division of Purchases", null],
  ]);

  // FINDING #9b — the two holes the finding-#9 fix left open.
  //
  // (a) The SLASH rule ran BEFORE the comma-led place-slot rejection, so a
  //     slash- or pipe-separated LOCATION LIST was read as department notation.
  //     POSTAL_RUN_AFTER only catches a bare postal code past the slash, and
  //     these lists are written with CITY names.
  table("VA reject (slash-separated location list)", [
    ["Work locations: Arlington, VA / Bethesda, MD / Washington, DC", null],
    ["Charlottesville, VA / Richmond, VA / Norfolk, VA", null],
    ["Offices: Reston, VA | Columbia, MD", null],
    ["Chantilly, VA/ Herndon, VA", null],
    ["Sterling, VA \\ Rockville, MD", null],
    // Minimal repro: nothing but a place slot and a slash.
    ["x, VA / Norfolk", null],
  ]);
  // (b) ORG_TAIL_BEFORE's word list is ordinary COMMERCIAL vocabulary. Any
  //     company or division name ending in one of these plus ", VA" — the most
  //     ordinary string there is in a Northern Virginia corpus — was accepted as
  //     the department.
  table("VA reject (company name ending in an org word)", [
    ["Leidos Digital Solutions Group, VA", null],
    ["Enterprise Services, VA", null],
    ["Network Operations Center, VA", null],
    ["Global Program, VA", null],
    ["Advanced Technology, VA", null],
    ["Logistics, VA", null],
    ["Booz Allen Hamilton Technology, VA", null],
    // A government word in an EARLIER segment must not vouch for this one.
    ["Contracting Office, Acme Solutions Group, VA", null],
  ]);
  // …while the cases the rule exists for keep working.
  table("VA accept (genuine government org tail / acronym notation)", [
    ["Contracting Office, VA - serving veterans in region 4", "VA"],
    ["Office of Information Technology, VA", "VA"],
    ["Defense Logistics Agency, VA", "VA"],
    ["VA/OI&T", "VA"],
    ["VA / OIT", "VA"],
  ]);
}

// ── 4. Full names beat stray acronyms, wherever the acronym sits ─────────────
{
  table("precedence", [
    ["Department of Energy — mail to DOT liaison", "DOE"],
    ["VA is copied. Issuing agency: Department of the Interior.", "DOI"],
    ["Department of Transportation in partnership with the Department of Energy", "DOT"],
    ["Bureau of Land Management, coordinating with DOE staff", "DOI"],
  ]);
}

// ── 5. Sub-agencies roll up ──────────────────────────────────────────────────
{
  table("rollup", [
    ["FAA", "DOT"], ["FMCSA", "DOT"], ["NHTSA", "DOT"], ["FHWA", "DOT"], ["PHMSA", "DOT"],
    ["Federal Motor Carrier Safety Administration", "DOT"],
    ["NIH", "HHS"], ["FDA", "HHS"], ["HRSA", "HHS"], ["SAMHSA", "HHS"],
    ["Centers for Medicare & Medicaid Services", "HHS"],
    ["BLM", "DOI"], ["USGS", "DOI"], ["BSEE", "DOI"],
    ["National Park Service", "DOI"],
    ["NNSA", "DOE"], ["Oak Ridge National Laboratory", "DOE"],
    ["VHA", "VA"], ["VISN 6", "VA"],
  ]);
}

// ── 6. Case sensitivity of acronyms ──────────────────────────────────────────
{
  table("case", [
    ["please dot the i's on the form", null],
    ["email jane@ibc.doi.gov", "DOI"],
    ["attach TEMPLATE.DOT to the response", null],
    ["Point of contact: John Doe", null],
    ["POC: JOHN DOE, CONTRACTING OFFICER", null],
    ["see DOI:10.1000/xyz123 for the study", null],
    ["USDOT Office of the Secretary", "DOT"],
    ["U.S. DEPARTMENT OF THE INTERIOR", "DOI"],
  ]);
  // The lower-case "doi" in this domain must NOT fire the case-sensitive
  // acronym rule — but the domain stage legitimately resolves it.
  eq("case: 'ibc.doi.gov' resolves by DOMAIN, not by acronym",
    matchDepartmentDetail("email jane@ibc.doi.gov")?.via, "domain");
}

// ── 6b. PERIOD-SEPARATED acronyms ────────────────────────────────────────────
// Regression guard. The acronym lists carry only the contiguous spelling, so
// every dotted form ("D.O.T.", "H.H.S.", "U.S.D.O.T.") used to match nothing at
// all, and the shared filename guard — written to reject "template.DOT" —
// additionally threw away "U.S.DOT"/"U.S.DOE"/"U.S.DOI", because the character
// in front of the acronym is the period of "U.S.". acronymRegex() now derives
// the dotted spelling and findAcronym() carves dotted initialisms out of the
// filename guard. The user types these cells by hand; dotted is normal.
{
  table("dotted acronym (department level)", [
    ["D.O.T.", "DOT"], ["D.O.E.", "DOE"], ["D.O.I.", "DOI"],
    ["H.H.S.", "HHS"], ["D.H.H.S.", "HHS"],
    ["U.S.D.O.T.", "DOT"], ["U.S.D.O.E.", "DOE"], ["U.S.D.O.I.", "DOI"],
    ["U.S.DOT", "DOT"], ["U.S.DOE", "DOE"], ["U.S.DOI", "DOI"],
    // No trailing period, and embedded in a sentence.
    ["D.O.T", "DOT"],
    ["the U.S.D.O.T. and its modal administrations", "DOT"],
  ]);
  table("dotted acronym (sub-agency level)", [
    ["F.A.A. Technical Center", "DOT"],
    ["N.I.H. Bethesda campus", "HHS"],
    ["B.L.M. Oregon district", "DOI"],
  ]);
  // The contiguous spellings must be untouched by the derived form.
  table("dotted acronym (contiguous forms unchanged)", [
    ["DOT", "DOT"], ["USDOT", "DOT"], ["US DOT", "DOT"], ["U.S. DOT", "DOT"],
    ["US-DOT", "DOT"], ["U S DOT", "DOT"], ["DOT.", "DOT"],
  ]);

  // EVERY GUARD MUST STILL BITE ON THE DOTTED SPELLING. A guard that never runs
  // because the term never matched is indistinguishable from a guard that works,
  // which is exactly how this class of bug hides.
  table("dotted acronym: filename/domain guard survives", [
    ["attach template.DOT to the response", null],
    ["TEMPLATE.DOT", null],
    ["report.DOE", null],
    ["proposal_v2.DOT", null],
    ["see DOI:10.1000/xyz123 for the study", null],
  ]);
  table("dotted acronym: jurisdiction guard survives", [
    ["Virginia D.O.T.", null],
    ["Ohio D.O.T.", null],
    ["City of Austin D.O.T.", null],
    ["Orange County D.O.T.", null],
    ["NYC D.O.E.", null],
    ["Chicago D.O.E.", null],
    ["Texas H.H.S.", null],
  ]);
  table("dotted acronym: citation + corroboration guards survive", [
    ["F.A.A.-compliant drone operations for the City of Austin", null],
    ["49 CFR D.O.T. hazmat training", null],
    ["Content Management System (C.M.S.) modernization", null],
    ["Net Promoter Score (N.P.S.) survey tooling", null],
  ]);
  // Ordinary prose and POC initials must not light up. "V.A." is the one
  // two-letter dotted form the derived spelling introduces, so the acceptVA()
  // paths are pinned here in both directions.
  table("dotted acronym: prose and initials stay null", [
    ["e.g. the vendor shall provide", null],
    ["i.e. all deliverables", null],
    ["a.b.c.d.e.f", null],
    ["Deploy the app. Analytics follow.", null],
    ["Robert V. Anderson, Program Manager", null],
    ["MARGUERITE V. RODRIGUEZ", null],
    ["Norfolk, V.A.", null],
  ]);
  table("dotted acronym: V.A. accepted only on VA's own evidence", [
    ["V.A. Medical Center", "VA"],
    ["V.A.", "VA"],
  ]);
}

// ── 7. State and local bodies must NOT be read as the federal department ─────
{
  table("jurisdiction full-name", [
    ["Virginia Department of Transportation", null],
    ["New York State Department of Transportation", null],
    ["Minnesota Department of Transportation (Mn/DOT)", null],
    ["North Carolina Department of Health and Human Services", null],
    ["City of Austin Department of Transportation", null],
    ["Connecticut Department of Energy and Environmental Protection", null],
    ["The Virginia Department of Transportation", null],
    ["Virginia\nDepartment of Transportation", null],
    // …but the federal ones must still come through
    ["U.S. Department of Transportation", "DOT"],
    ["United States Department of Transportation", "DOT"],
    ["The U.S. Department of Health and Human Services", "HHS"],
  ]);

  // FINDING #12 — JURISDICTION_PREFIX was anchored with `\s*…$`, so ANY
  // punctuation between the jurisdiction and the department name defeated it.
  // A comma or a dash was enough, and that is a very common way to write a
  // state agency. All four used to resolve to the federal department.
  table("jurisdiction punctuation (finding #12)", [
    ["Commonwealth of Virginia, Department of Transportation", null],
    ["State of Ohio, Department of Transportation", null],
    ["Ohio, Department of Transportation", null],
    ["Virginia  -  Department of Transportation", null],
    ["State of Ohio — Department of Transportation", null],
    ["Texas; Department of Health and Human Services", null],
  ]);

  // FINDING #13 — the guard only knew "<kind> of <name>" and bare state names,
  // so it missed the far more common POSTPOSITIVE form, US territories, and
  // tribal nations. Six of these eight used to resolve federal.
  table("jurisdiction postpositive / territory / tribal (finding #13)", [
    ["Los Angeles County Health and Human Services Agency", null],
    ["Cook County Health and Human Services", null],
    ["Chicago Department of Transportation", null],
    ["Seattle Department of Transportation (SDOT)", null],
    ["Guam Department of Transportation", null],
    ["Virgin Islands Department of Transportation", null],
    ["Navajo Nation Department of Transportation", null],
    ["Massachusetts Bay Transportation Authority Department of Transportation", null],
    // Not a US jurisdiction at all, but equally not the US DOT.
    ["Toronto Department of Transportation", null],
    ["City of Chicago Department of Transportation", null],
    ["American Samoa Department of Transportation", null],
    ["Rochester City School District Department of Transportation", null],
  ]);

  // The bare-city rule is deliberately anchored to a LINE START, because
  // "Austin", "Charlotte" and "Jackson" are also personal names and this corpus
  // is full of POC name lines directly above an agency name.
  eq("jurisdiction: a POC surname is not a city", matchDepartment("Jane Austin\nDepartment of Transportation"), "DOT");
}

// ── 7b. The same, when the row NEVER SPELLS THE FULL NAME OUT ────────────────
// Regression guard. The full-name jurisdiction check cannot fire on a string
// that contains no full name, and state/city rows overwhelmingly write the bare
// acronym: "Virginia DOT", "NY DOT", "Mn/DOT". Every one of these was being
// labelled as the federal department. Note that at state level the acronyms mean
// different things outright — DOE is Education, DOI is Insurance.
{
  for (const s of [
    "Virginia DOT", "NY DOT", "Ohio DOT", "Minnesota DOT", "PA DOT", "Mn/DOT",
    "New York State DOT", "Caltrans / California DOT", "Texas DOT invitation to bid",
    "Orange County DOT", "City of Austin DOT", "State of Alaska DOT&PF", "NYC DOT",
    "Guam DOT", "Minnesota (DOT) bridge inspection",
  ]) eq(`jurisdiction acronym: ${JSON.stringify(s)} → null`, matchDepartment(s), null);

  table("jurisdiction acronym (state meanings differ)", [
    ["California DOE", null],   // Department of Education
    ["California DOI", null],   // Department of Insurance
    ["Texas HHS Commission", null],
  ]);

  // Glued state forms never matched (the acronym scan is word-bounded) — pinned
  // so a future loosening of acronymRegex() cannot quietly reintroduce them.
  for (const s of ["VDOT", "TxDOT", "MnDOT", "WSDOT", "Caltrans"])
    eq(`jurisdiction acronym: ${s} → null`, matchDepartment(s), null);

  // …and the federal readings must survive.
  table("federal acronym", [
    ["DOT", "DOT"],
    ["U.S. DOT", "DOT"],
    ["US DOT", "DOT"],
    ["DOT/FAA", "DOT"],
    ["Virginia DOT coordination with the U.S. DOT", "DOT"],
    // A rejected acronym does not suppress the domain stage.
    ["Washington DC DOT office, contact jane.doe@dot.gov", "DOT"],
    // Sub-agency acronyms are deliberately NOT jurisdiction-guarded: FAA, FDA,
    // NIH and BLM have no state analogue, so a place name in front is a place.
    ["FDA Minnesota District Office", "HHS"],
    ["Oregon BLM district", "DOI"],
  ]);

  // The helper itself, since acceptVA() now depends on it directly.
  check("isJurisdictionOwnedAcronym('Fairfax County, ')", isJurisdictionOwnedAcronym("Fairfax County, "));
  check("isJurisdictionOwnedAcronym('U.S. ') is false", !isJurisdictionOwnedAcronym("U.S. "));
  check("isJurisdictionOwnedAcronym('') is false", !isJurisdictionOwnedAcronym(""));
}

// ── 7b-bis. The state-owned suppression is PER OCCURRENCE, not per department ─
// It used to be a plain per-department flag: one jurisdiction-owned full name
// anywhere in the cell suppressed that department for the WHOLE acronym, domain
// and fuzzy stages. That deleted the commonest shape there is — a state body
// naming its federal partner — from the filter the user asked for. The rule it
// replaces is the one §16 already pins for the agency/title join: adjacency, not
// "a state word appears somewhere in the cell".
{
  // (a) The state body names the federal one. The federal mention must survive.
  table("state-owned: a federal mention elsewhere in the cell survives", [
    ["Virginia Department of Transportation coordinating with USDOT", "DOT"],
    ["Virginia Department of Transportation is one partner. Award will be made by the U.S. DOT under a separate action.", "DOT"],
    ["Texas Health and Human Services Commission; the award will ultimately be funded directly by HHS.", "HHS"],
    ["Minnesota Department of Transportation was the incumbent. The follow-on buyer is DOT.", "DOT"],
    ["Chicago Department of Transportation ran the pilot; the production award will be made by DOT.", "DOT"],
    // …including through the DOMAIN stage, which the flag also used to suppress.
    ["Virginia Department of Transportation, federal partner contact dana.whitfield.ctr@dot.gov", "DOT"],
  ]);

  // (b) …and the thing the flag actually existed for still holds: the acronym
  //     standing right next to the state-owned name is that name abbreviated.
  table("state-owned: the state body's own abbreviation is still rejected", [
    ["Minnesota Department of Transportation (DOT) bridge inspection", null],
    ["Minnesota Department of Transportation (Mn/DOT)", null],
    ["Virginia Department of Transportation, DOT, paving RFP", null],
    ["Virginia Department of Transportation or DOT", null],
    ["Texas Health and Human Services Commission (HHS)", null],
    // The same construction written in the other order.
    ["DOT (Virginia Department of Transportation) paving RFP", null],
    ["DOT, Virginia Department of Transportation", null],
    // …but a real clause between them is two separate mentions, not one name.
    ["U.S. DOT and the Virginia Department of Transportation", "DOT"],
  ]);

  // (c) The US-prefixed spellings are federal on their face — no state, county
  //     or city abbreviates ITSELF "USDOT" — so a jurisdiction earlier in the
  //     cell can never own one. The Energy/Education guard still runs first.
  table("US-prefixed department acronyms prove federal ownership", [
    ["Virginia USDOT liaison office", "DOT"],
    ["Fairfax County USDOI coordination", "DOI"],
    ["USDOE campus energy audit", "DOE"],
    ["USDOE school district curriculum portal", null],
  ]);
}

// ── 7c. FINDING #10 — DOE had NO Energy-vs-Education guard ──────────────────
// Every school-district DOE resolved to Department of Energy. Two of the user's
// own rows (sheet 7 and 45) are New York City Department of Education
// solicitations; see section 20 for the live versions.
{
  table("DOE education guard (finding #10)", [
    ["NYC DOE", null],
    ["NYC DOE Division of Instructional and Information Technology", null],
    ["Chicago DOE", null],
    ["DOE - Department of Education", null],
    ["DOE (Education)", null],
    ["state DOE certification", null],
    ["The New York City (NYC) Department of Education (DOE), through its Division of Instructional and Information Technology (DIIT)", null],
    ["tbenne2@schools.nyc.gov\nstrengthen the security of DOE's expansive technology environment", null],
    // …and the federal Energy readings must survive. Energy vocabulary outranks
    // the education test so a genuine DOE notice mentioning STEM education is
    // not thrown away.
    ["DOE", "DOE"],
    ["Issued by the agency (DOE)", "DOE"],
    ["U.S. DOE Office of Science", "DOE"],
    ["DOE nuclear waste cleanup with a K-12 education outreach component", "DOE"],
    ["Department of Education", null],   // not DOE=Energy, and not a priority dept
  ]);
}

// ── 7c-bis. The education guard was TOO WIDE and ate the Office of Science ──
// The first version of EDUCATION_EVIDENCE rejected on `academic`, `university`,
// `students` and a bare `schools` ANYWHERE in the text, unless the word "Energy"
// (or nuclear/NNSA/grid/national laborator) also appeared literally. That is the
// everyday vocabulary of the DOE Office of Science, whose core mission is
// funding university and academic research and running STEM workforce
// programmes. Every row below returned null — the user filters on DOE and their
// own pursuit is not in the list. The guard now asks for an education
// INSTITUTION (department/board of education, school district, superintendent,
// classroom/K-12, a school-system domain), not for the subject of education.
{
  table("DOE education guard is not triggered by academic vocabulary", [
    ["DOE Office of Science - academic research computing support", "DOE"],
    ["DOE Office of Science university user facility operations", "DOE"],
    ["DOE STEM workforce program for students", "DOE"],
    ["DOE Argonne site support including school outreach", "DOE"],
    ["DOE - Office of Environmental Management, academic partners", "DOE"],
    ["DOE university research partnership - academic computing", "DOE"],
    ["DOE Oak Ridge student internship administration", "DOE"],
    ["DOE graduate fellowship program administration", "DOE"],
    // The site/office name alone is enough; the word "Energy" need not appear.
    ["DOE Hanford site IT support", "DOE"],
    ["DOE - Pantex Plant records management", "DOE"],
    // Real education BODIES must still be rejected, with no "Energy" word.
    ["DOE school district student information system", null],
    ["DOE - Board of Education technology refresh", null],
    ["DOE superintendent's office network upgrade", null],
    ["Fairfax County Public Schools DOE classroom devices", null],
    ["helpdesk@k12.va.us - DOE ticketing system", null],
    // …and an Energy signal still outranks an education one.
    ["DOE nuclear waste cleanup with K-12 education outreach", "DOE"],
    ["DOE Argonne National Laboratory K-12 STEM classroom program", "DOE"],
  ]);

  // The Energy/Education guard applies to BOTH spellings. "USDOE" previously
  // carried no accept() at all, so identical text was filed one way or the other
  // purely on how the user abbreviated it.
  table("USDOE carries the same guard as DOE", [
    ["USDOE campus energy audit", "DOE"],
    ["USDOE Office of Science - academic research support", "DOE"],
    ["USDOE school district curriculum portal", null],
    ["DOE school district curriculum portal", null],
  ]);
}

// ── 7d. FINDING #14 — sub-agency acronyms collide with ordinary vocabulary ──
// This corpus is NAICS 541511/54151S: custom software and IT services. "CMS" is
// a Content/Contract Management System far more often than the Centers for
// Medicare & Medicaid Services, and "NPS" is a Net Promoter Score. Those
// acronyms now require the parent department to be named independently.
{
  table("collision-prone acronyms, bare (finding #14)", [
    ["Content Management System (CMS) implementation", null],
    ["Contract Management System (CMS) support services", null],
    ["CMS migration to Drupal", null],
    ["Content Management System (CMS) modernization", null],
    ["IHS Markit / S&P Global data license", null],
    ["NPS - Net Promoter Score survey tooling", null],
    ["FRA - Financial Reporting Application", null],
    ["FTA - Free Trade Agreement compliance", null],
    ["BIA data - Bureau of Industry and Analysis", null],
    ["CDC Software / ERP vendor", null],
    ["IBC review for the building shell", null],   // International Building Code
    ["ACL configuration on the firewall", null],   // Access Control List
  ]);
  // …and the corroborated forms still resolve. Corroboration = the parent
  // department's own name, its own acronym, or one of its .gov domains.
  table("collision-prone acronyms, corroborated", [
    ["HHS CMS - claims platform modernization", "HHS"],
    ["CMS enrollment system, contact jane@cms.gov", "HHS"],
    ["Department of Health and Human Services — CDC surveillance data", "HHS"],
    ["DOI NPS visitor-services platform", "DOI"],
    ["DOT FRA safety data warehouse", "DOT"],
    ["HHS ACF - Data Analytics Support - MRAS", "HHS"],
    ["Department of Energy EIA - IT Service Desk Support", "DOE"],
  ]);
  // …and — the case this suite used to be missing entirely — a SUB-AGENCY-ONLY
  // notice, which is how real federal solicitations are actually written. The
  // operating division names only itself, because inside the government the
  // parent is implicit. Requiring the parent made every one of these null, i.e.
  // the user's own pursuit vanishing from the department filter they asked for,
  // which is the worst outcome this module can produce. These now resolve on
  // the bureau's own MISSION vocabulary (see MISSION VOCABULARY in
  // src/lib/departments.ts) — never on its org chart, never on a generic IT
  // verb, which is what keeps the reject table above passing.
  table("collision-prone acronyms, sub-agency alone + mission vocabulary", [
    ["CMS Interoperability and Prior Authorization API implementation", "HHS"],
    ["CMS Baltimore MD - Medicare Advantage data platform", "HHS"],
    ["NPS park pass e-commerce platform", "DOI"],
    ["ACF Office of Child Support Services case management", "HHS"],
    ["IHS Albuquerque Area Office - EHR modernization", "HHS"],
    ["CDC Atlanta - National Syndromic Surveillance Program", "HHS"],
    ["FTA Section 5307 transit grant management system", "DOT"],
    ["FRA Office of Railroad Safety - track inspection data", "DOT"],
    ["BIA Office of Justice Services records system", "DOI"],
    ["ACL Older Americans Act reporting system", "HHS"],
    ["NCI cancer imaging data commons", "HHS"],
    ["OSM abandoned mine land inventory", "DOI"],
    ["BOR Colorado River water delivery scheduling", "DOI"],
    ["SNL - Sandia high-performance computing support", "DOE"],
    ["OST Office of the Secretary - departmental IT", "DOT"],
    // The mission words alone, with NO acronym, still match nothing. This is
    // what proves the vocabulary is a corroborator and not a second matcher.
    ["Medicare Advantage data platform", null],
    ["park pass e-commerce platform", null],
    ["transit grant management system", null],
    // Mission vocabulary does not outrank the regulatory-citation guard: a
    // state Medicaid system that merely has to be CMS-certified is not a CMS
    // pursuit.
    ["State of Ohio Medicaid MMIS - CMS certification required", null],
  ]);
  // THE COST OF MISSION VOCABULARY, AND THE TWO GUARDS THAT PAY IT. Widening
  // corroboration to mission words re-opens a false positive whenever the
  // civilian homonym and a mission word share a row. Both are closed:
  //
  // (a) The row DEFINES the acronym itself — "Content Management System (CMS)".
  //     A parenthetical gloss whose initials spell the acronym is the author
  //     saying what they mean, and it beats a mission word elsewhere. Safe for
  //     real bureaus because a gloss holding the GENUINE name ("National Park
  //     Service (NPS)") is matched by Stage 1 and never reaches this code.
  table("acronym glossed as its civilian expansion beats mission vocabulary", [
    ["Content Management System (CMS) for the Medicare Rights Center, a nonprofit", null],
    ["Net Promoter Score (NPS) survey for national park concessionaires", null],
    ["Business Impact Analysis (BIA) for a tribal casino", null],
    ["Free Trade Agreement (FTA) impact on transit rolling stock imports", null],
    ["Financial Reporting Application (FRA) for a railroad holding company", null],
    ["Access Control List (ACL) for an aging services nonprofit", null],
    ["Environmental Impact Assessment (EIA) of petroleum storage", null],
    ["International Building Code (IBC) review of a shared services center", null],
    // CamelCase single-token gloss: "OpenStreetMap" → O,S,M.
    ["OpenStreetMap (OSM) tiles of abandoned mine land", null],
    // …and the genuine article, glossed the same way, still resolves — via the
    // Stage 1 full-name scan, which is what makes the guard safe.
    ["National Park Service (NPS) visitor platform", "DOI"],
    ["Federal Transit Administration (FTA) grant management", "DOT"],
    ["Centers for Medicare and Medicaid Services (CMS) claims system", "HHS"],
  ]);
  // (b) A NAMED company that owns the acronym. Such a row says "tribal" or
  //     "public health" for reasons of its own, so mission vocabulary must not
  //     rescue it.
  table("commercial homonym beats mission vocabulary", [
    ["IHS Markit tribal lands data license", null],
    ["CDC Software ERP for a county public health department", null],
  ]);
  // These stay safe alone — they have no competing civilian meaning here.
  table("acronyms deliberately safe alone", [
    ["FAA", "DOT"], ["FMCSA", "DOT"], ["NHTSA", "DOT"],
    ["NIH", "HHS"], ["FDA", "HHS"], ["NCHS", "HHS"], ["NIOSH", "HHS"], ["ASPE", "HHS"],
    ["BLM", "DOI"], ["USGS", "DOI"], ["USBR", "DOI"], ["FWS", "DOI"],
    ["ORNL", "DOE"], ["PNNL", "DOE"], ["LLNL", "DOE"], ["INL", "DOE"], ["NREL", "DOE"],
  ]);
}

// ── 7e. FINDING #15 — regulatory citations read as the issuing agency ───────
// A city or DoD solicitation that merely CITES a federal standard is not a
// pursuit with that standard's owner.
{
  table("regulatory citations (finding #15)", [
    ["FAA-compliant drone operations for the City of Austin", null],
    ["Requires FAA Part 107 certification. Issued by City of Dallas.", null],
    ["49 CFR DOT hazmat training", null],
    ["DOT-compliant hazmat placarding for Amtrak", null],
    ["OSHA and DOT regulations apply", null],
    ["FDA 21 CFR Part 11 compliant system for a DoD lab", null],
    ["NIH Stroke Scale training module for a state hospital", null],
    ["in accordance with DOT guidelines", null],
    // …but a citation elsewhere must not suppress a genuine naming later on.
    ["FAA-compliant drone operations procured by the Federal Aviation Administration", "DOT"],
    ["Issued by DOT.", "DOT"],
  ]);

  // THE ACCEPT SIDE OF THE SAME GUARD. Certification / Standards / Rules /
  // Guidelines / Requirements / Compliance / Approved / Form are the words
  // federal agencies put in the titles of their OWN contracts. A guard that
  // rejects on the bare noun deletes the buyer from the single most common
  // title shape in this corpus, which is a false NEGATIVE — the user's own
  // pursuit vanishes from the department filter they asked for. The
  // discriminator is capitalisation: a Capitalised noun is part of a
  // program/office/system name, a lowercase one is running prose.
  table("regulatory nouns inside a legitimate agency title", [
    ["FAA Certification Services Support Contract", "DOT"],
    ["FAA Approved Repair Station data system", "DOT"],
    ["DOT Standards Modernization Program", "DOT"],
    ["DOT Rules Docket Management System", "DOT"],
    ["DOT - Compliance Tracking System", "DOT"],
    ["HHS Requirements Analysis and Systems Engineering", "HHS"],
    ["HHS Regulations.gov modernization", "HHS"],
    ["VA Compliance and Business Integrity Office support", "VA"],
    ["VA Certification of Eligibility processing", "VA"],
    ["NIH Guidelines review portal", "HHS"],
    ["FDA Form 483 response tracking system", "HHS"],
    ["DOE Compliance Tracking System", "DOE"],
    ["DOI Standards and Guidelines Working Group", "DOI"],
    ["BLM Rules and Regulations publishing platform", "DOI"],
  ]);

  // …and the lowercase counterparts stay rejected. Same nouns, prose casing.
  table("regulatory nouns in lowercase prose stay rejected", [
    ["OSHA and DOT standards apply", null],
    ["state DOE certification", null],
    ["must hold FAA certification", null],
    ["DOI guidelines for a county land-use study", null],
    // Collision-prone acronyms are gated by the citation guard BEFORE their
    // mission-vocabulary corroboration ever runs (see module header).
    ["CMS certification required for the state Medicaid MMIS", null],
  ]);
}

// ── 7f. FINDING #16/#17 — ampersand, "Dept." and inverted news styling ──────
// Handled ONCE in phraseRegex()'s token table, not by pasting variants into
// every list: Department↔Dept.↔Dept, Administration↔Admin., and↔&.
{
  table("ampersand (finding #16)", [
    ["Department of Health & Human Services", "HHS"],
    ["Health & Human Services", "HHS"],
    ["Department of Health and Human Services", "HHS"],
    ["Fish & Wildlife Service", "DOI"],
  ]);
  table("Dept. abbreviation and news styling (finding #17)", [
    ["Dept. of Transportation", "DOT"],
    ["Dept of Energy", "DOE"],
    ["Dept. of the Interior", "DOI"],
    ["U.S. Dept. of Transportation", "DOT"],
    ["Transportation Department", "DOT"],
    ["Energy Department", "DOE"],
    ["Interior Department", "DOI"],
    ["The Energy Dept.", "DOE"],
    ["Dept. of Health and Human Services", "HHS"],
    ["U.S. Dept of Veterans Affairs", "VA"],
    ["Federal Aviation Admin.", "DOT"],
    // The abbreviation must NOT smuggle a state agency past the guard.
    ["Virginia Dept. of Transportation", null],
    ["Ohio Dept of Transportation", null],
  ]);
}

// ── 7g. FINDING #18 — sub-agency name/acronym gaps ─────────────────────────
{
  table("DOE national laboratories (finding #18)", [
    ["Los Alamos National Laboratory", "DOE"],
    ["Sandia National Laboratories", "DOE"],
    ["Argonne National Laboratory", "DOE"],
    ["National Renewable Energy Laboratory (NREL)", "DOE"],
    ["Brookhaven National Laboratory", "DOE"],
    ["Savannah River Site", "DOE"],
    ["Oak Ridge National Lab", "DOE"],
    ["ORNL", "DOE"], ["PNNL", "DOE"], ["LLNL", "DOE"], ["INL", "DOE"],
  ]);
  table("DOI bureaus (finding #18)", [
    ["USBR", "DOI"], ["FWS", "DOI"],
    ["Bureau of Reclamation", "DOI"],
    ["Office of Surface Mining Reclamation and Enforcement", "DOI"],
    // DELIBERATE DEVIATION FROM THE FINDING, documented rather than silent:
    // "OSM" is OpenStreetMap and "BOR" is a Board of Regents in this corpus far
    // more often than they are Interior bureaus, so both are corroboration-only.
    // Bare, they stay null; named alongside DOI they resolve.
    ["OSM basemap tiles for the GIS refresh", null],
    ["BOR meeting minutes archive", null],
    ["DOI OSM surface-mining permit system", "DOI"],
    ["Department of the Interior BOR water data", "DOI"],
  ]);
  table("HHS operating divisions (finding #18)", [
    ["Administration for Children and Families", "HHS"],
    ["Administration for Community Living", "HHS"],
    ["National Cancer Institute", "HHS"],
    ["NIOSH", "HHS"], ["ASPE", "HHS"],
    ["National Institute for Occupational Safety and Health", "HHS"],
  ]);
  table("DOT operating administrations (finding #18)", [
    ["Volpe Center", "DOT"],
    ["Volpe National Transportation Systems Center", "DOT"],
    ["Office of the Secretary of Transportation (OST)", "DOT"],
    ["Great Lakes St. Lawrence Seaway Development Corporation", "DOT"],
    ["Saint Lawrence Seaway Development Corporation", "DOT"],
    ["Federal Aviation Admin.", "DOT"],
  ]);
  eq("VA: Veterans Canteen Service", matchDepartment("Veterans Canteen Service"), "VA");
}

// ── 8. Non-priority agencies stay null (the crawler sees these daily) ────────
{
  for (const text of [
    "General Services Administration",
    "GSA Federal Acquisition Service",
    "Department of Justice",
    "DOJ / Federal Prison Industries",
    "Department of Agriculture",
    "USDA Forest Service",
    "Department of Homeland Security",
    "Department of Defense",
    "Department of Housing and Urban Development",
    "National Science Foundation",
    "Federal Election Commission",
    "Metropolitan Council",
    "Office of General Services, New York",
    "Department of Labor",
    "Department of ED",           // sheet row 57 — Education, not a priority dept
    "Defense Health Agency (DHA)",
    "",
  ]) {
    eq(`non-priority: ${JSON.stringify(text.slice(0, 42))} → null`, matchDepartment(text), null);
  }
  eq("null input → null", matchDepartment(null), null);
  eq("undefined input → null", matchDepartment(undefined), null);
  eq("whitespace-only → null", matchDepartment("   \n  "), null);
}

// ── 9. Word boundaries ───────────────────────────────────────────────────────
{
  table("boundary", [
    ["DOTS AND DASHES INC", null],
    ["CDCX SYSTEMS", null],
    ["NAVAL SUPPLY SYSTEMS COMMAND", null],
    ["ADVANCE PLANNING BRIEFING", null],
    ["Issued by DOT.", "DOT"],
    ["Issued by the agency (DOE)", "DOE"],
    ["FMCS IT Consulting Services", null],   // sheet row 40 — FMCS is not FMCSA
    ["PennDOT Mainframe Services", null],    // sheet row 66 — glued state form
  ]);
}

// ── 10. departmentForOpportunity: agency first, then agency+title together ──
{
  // DELIBERATE REVERSAL, and the point of finding #11. This used to assert null
  // on the grounds that "the portal already told us who is buying". It does not:
  // for GSA eBuy / MRAS rows the agency column is the market-research desk and
  // the customer is named only in the description. Six real rows were invisible
  // in the department filter because of the old rule. See section 20.
  eq("opp: a non-matching agency no longer blocks the title",
    departmentForOpportunity("General Services Administration", "FAA tower equipment refresh"), "DOT");
  eq("opp: title used when agency is null",
    departmentForOpportunity(null, "FAA tower equipment refresh"), "DOT");
  eq("opp: title used when agency is blank",
    departmentForOpportunity("", "Support services for the Department of Energy"), "DOE");
  eq("opp: an agency that DOES match short-circuits the title",
    departmentForOpportunity("Department of the Interior", "FAA coordination"), "DOI");
  eq("opp: both null → null", departmentForOpportunity(null, null), null);
  // The agency block carries NEGATIVE evidence the title lacks — the two are
  // matched together, never the title alone.
  eq("opp: school-district agency block vetoes a bare DOE in the title",
    departmentForOpportunity("tbenne2@schools.nyc.gov", "strengthen the security of DOE's environment"), null);
  // The jurisdiction guard vetoes the acronym when the jurisdiction runs
  // straight into it across the agency/title join…
  eq("opp: state agency block vetoes an adjacent DOT in the title",
    departmentForOpportunity("Virginia", "DOT bridge inspection program"), null);
  // …AND when the jurisdiction owns the agency NAME the acronym hangs off, even
  // with words in between.
  //
  // DELIBERATE REVERSAL. This assertion previously expected "DOT" on the theory
  // that the guard is a pure ADJACENCY rule ("a state word appears somewhere" is
  // not enough, because "Herndon, VA 20170" is in federal contact blocks all
  // day). That theory is right about bare state words in ADDRESSES and wrong
  // here: "Virginia / Richmond office / DOT bridge inspection" is the Virginia
  // DOT's Richmond District, and calling it the federal DOT is a false positive
  // on the user's own filter. The address case is preserved verbatim two
  // assertions below — a state word in a postal block still does NOT veto.
  eq("opp: a state that owns the agency NAME vetoes the acronym",
    departmentForOpportunity("Virginia\nRichmond office", "DOT bridge inspection program"), null);
  // The intent the old assertion was protecting, stated directly: a state name
  // that is part of a POSTAL ADDRESS is not a jurisdiction claim on the acronym.
  eq("opp: a state word in a postal address does not veto a federal acronym",
    departmentForOpportunity("Jane Doe\n381 Elden Street, Suite 4000\nHerndon, VA 20170",
      "DOT bridge inspection program"), "DOT");
}

// ── 10b. The jurisdiction guard is NOT adjacency-only ────────────────────────
// Every case here was a live FALSE POSITIVE: the acronym was filed as the
// federal department because the state/county/city that owns it sat one or more
// words earlier instead of directly against it. The multi-line forms are the
// shape the user's hand-typed Agency/POC cells actually take — jurisdiction on
// one line, acronym several lines later.
{
  table("not-adjacent jurisdiction", [
    ["Virginia Department of Motor Vehicles - DOT records interface", null],
    ["New York State Department of Motor Vehicles DOT interface", null],
    ["Maryland Transit Administration DOT grant application", null],
    ["Ohio Turnpike and Infrastructure Commission DOT filing", null],
    ["Nassau County\nDepartment of Public Works\nDOT coordination", null],
    ["Angela Perez\nPurchasing Agent\nCounty of Orange\n300 N Flower St\nDOT paving RFP", null],
    ["The Commonwealth of Virginia through its Department of General Services seeks DOT-related data", null],
    ["Texas Department of Licensing and Regulation HHS data share", null],
    ["State of Georgia\nOffice of Procurement\nDOE energy audit", null],
    // LOCAL_BODY_SUFFIX carries "Nation", but the tail token here is the place
    // name — so the of-form has to carry the tribal kinds too.
    ["Tribal Nation of Oneida DOT", null],
    // A city that is not, and never will be, in MAJOR_LOCAL_NAMES was read as
    // the federal DOT. State capitals are now in the list.
    ["Boise Department of Transportation", null],
  ]);

  check("guard sees a jurisdiction one word back",
    isJurisdictionOwnedAcronym("Virginia Department of Motor Vehicles "));
  check("guard sees a jurisdiction one LINE back",
    isJurisdictionOwnedAcronym("Nassau County\nDepartment of Public Works\n"));
  check("guard sees a state that owns a transit agency",
    isJurisdictionOwnedAcronym("Maryland Transit Administration "));
  check("guard still sees the adjacent case",
    isJurisdictionOwnedAcronym("Virginia "));

  // THE OTHER SIDE OF THE RULE. A bare place name must never be scanned across
  // the whole cell: stripPostalAddresses() leaves "Washington" behind, DC's
  // streets are named after states, and the user's real row 58 is a federal DOI
  // row whose POC block says "Boston, MA 02222" ~120 characters before the
  // acronym that identifies it. These MUST stay federal.
  table("federal rows a wide scan would have eaten", [
    ["FEDERAL ACQUISITION SERVICE\nBoston, MA 02222\nGSA MARKET RESEARCH\n1-800-488-3111\nDOI secure AI assistant", "DOI"],
    ["Gsa Market Research\nGeneral Services Administration\nFederal Acquisition Service\nrfi@research.gsa.gov\nHHS ACF - Data Analytics Support", "HHS"],
    ["Herndon, VA 20170\nDOI land records", "DOI"],
    ["DOT Seattle office", "DOT"],
    ["U.S. DOT\nDenver office", "DOT"],
    ["U.S. Department of Transportation\nRichmond office", "DOT"],
  ]);
}

// ── 11. Exports the rest of the app relies on ────────────────────────────────
{
  eq("codes: five of them", DEPARTMENT_CODES.length, 5);
  eq("codes: in the priority order", DEPARTMENT_CODES.join(","), "DOT,DOI,DOE,VA,HHS");
  check("isPriorityDepartment('DOT')", isPriorityDepartment("DOT"));
  check("isPriorityDepartment('GSA') is false", !isPriorityDepartment("GSA"));
  check("isPriorityDepartment(null) is false", !isPriorityDepartment(null));
}

// ── 12. Real-ish multi-line rows in the shape the sheet actually stores ─────
{
  table("row", [
    ["DOT/FAA\nContracts and Purchasing\n800 Independence Ave SW\nWashington, DC 20591", "DOT"],
    ["FMCSA\nBernadette Okafor\nbernadette.okafor@dot.gov", "DOT"],
    ["Department of Veterans Affairs\nTechnology Acquisition Center\nEatontown, NJ 07724", "VA"],
    ["U.S. Department of Energy\nNNSA Albuquerque Complex\nAlbuquerque, NM 87116", "DOE"],
    ["Issuing Agency: Centers for Medicare & Medicaid Services\n7500 Security Blvd\nBaltimore, MD 21244", "HHS"],
    ["Metropolitan Council\n390 Robert Street North\nSaint Paul, MN 55101", null],
    ["Federal Prison Industries (UNICOR)\nDOJ\nWashington, DC 20534", null],
  ]);
}

// ── 13. SAM.gov's inverted agency strings ───────────────────────────────────
// src/lib/connectors/sam.ts:93 builds agency from `fullParentPathName`, e.g.
// "TRANSPORTATION, DEPARTMENT OF.FEDERAL AVIATION ADMINISTRATION." → first two
// segments joined with " · ". Every federal SAM row arrives in this shape.
{
  const sam = (path: string) => path.split(".").slice(0, 2).join(" · ");
  eq("sam: TRANSPORTATION, DEPARTMENT OF",
    matchDepartment(sam("TRANSPORTATION, DEPARTMENT OF.FEDERAL AVIATION ADMINISTRATION.FAA")), "DOT");
  eq("sam: INTERIOR, DEPARTMENT OF THE",
    matchDepartment(sam("INTERIOR, DEPARTMENT OF THE.OFFICE OF THE SECRETARY")), "DOI");
  eq("sam: ENERGY, DEPARTMENT OF (no bureau to fall back on)",
    matchDepartment(sam("ENERGY, DEPARTMENT OF.OFFICE OF SCIENCE")), "DOE");
  eq("sam: VETERANS AFFAIRS, DEPARTMENT OF",
    matchDepartment(sam("VETERANS AFFAIRS, DEPARTMENT OF.VA TECHNOLOGY ACQUISITION CENTER")), "VA");
  eq("sam: HEALTH AND HUMAN SERVICES, DEPARTMENT OF",
    matchDepartment(sam("HEALTH AND HUMAN SERVICES, DEPARTMENT OF.NATIONAL INSTITUTES OF HEALTH")), "HHS");
  eq("sam: AGRICULTURE, DEPARTMENT OF → null (not a priority dept)",
    matchDepartment(sam("AGRICULTURE, DEPARTMENT OF.FOREST SERVICE")), null);
  eq("sam: JUSTICE, DEPARTMENT OF → null", matchDepartment(sam("JUSTICE, DEPARTMENT OF.FEDERAL PRISON INDUSTRIES")), null);
  // The inverted alias must not chew through a POC line and lose the real dept.
  eq("sam: a name before ', Department of the Interior' still resolves",
    matchDepartment("MARGUERITE RODRIGUEZ, Department of the Interior"), "DOI");
}

// ── 15. .gov domain fallback, and the sheet rows that forced it ─────────────
{
  // Real row 67: a POC block with no agency name anywhere — the email is the
  // only evidence in the cell.
  eq("domain: bare POC block with @dot.gov",
    matchDepartment("Primary Point of Contact: Dana Whitfield\nEmail: dana.whitfield.ctr@dot.gov\nPhone: 2025550143"),
    "DOT");
  // Real row 72: "FHWA" is glued to other letters so the acronym must NOT fire;
  // the domain carries it instead.
  eq("domain: FHWASmallBusiness@dot.gov (acronym is glued, domain wins)",
    matchDepartment("Small Business Specialist Info: Riley Mason\nFHWASmallBusiness@dot.gov"), "DOT");
  // Real row 63.
  eq("domain: NCHS / amr7@cdc.gov → HHS",
    matchDepartment("NCHS\n3311 Toledo Rd.\nHyattsville, MD 20782\nAmara Rahimi\namr7@cdc.gov"), "HHS");

  // THE REGRESSION THIS STAGE ALMOST INTRODUCED — real row 18. "danvilleva.gov"
  // contains the substring "va.gov"; this is the City of Danville, Virginia.
  eq("domain: 'danvilleva.gov' is NOT va.gov",
    matchDepartment("Dana Hollis\nDepartment of City of Danville VA\npurchasing@danvilleva.gov\n" +
      "electronic submissions: www.eva.virginia.gov"), null);
  eq("domain: 'nova.gov' is not va.gov", matchDepartment("contact us at info@nova.gov"), null);
  // …while genuine subdomains and www forms still resolve.
  eq("domain: 'www.va.gov' → VA", matchDepartment("see www.va.gov for details"), "VA");
  eq("domain: 'jane@ibc.doi.gov' → DOI", matchDepartment("jane@ibc.doi.gov"), "DOI");

  // Non-priority .gov domains stay null (real rows 25, 44, 47).
  table("domain non-priority", [
    ["kearnsley.jamie.r@dol.gov", null],
    ["Rowan Chapin\nFederal Election Commission\nrchapin@fec.gov", null],
    ["dwarrick@usagm.gov", null],
    ["Gsa Market Research\nsomeone@gsa.gov", null],
    ["nora.kempf@ed.gov", null],
    ["tbenne2@schools.nyc.gov", null],
  ]);

  // Precedence: a named department outranks a contractor's mailbox domain.
  eq("domain: full name beats a domain later in the block",
    matchDepartment("Department of the Interior\nBernadette Okafor\nbernadette@dot.gov"), "DOI");
}

// ── 14. Idempotence / determinism ───────────────────────────────────────────
{
  const samples = [
    "DOT/FAA", "Department of the Interior\nHerndon, VA 20170", "VA", "CUNY", "NIH", "",
  ];
  const once = samples.map((s) => matchDepartment(s));
  const twice = samples.map((s) => matchDepartment(s));
  eq("deterministic across calls (no leaked regex lastIndex)", JSON.stringify(once), JSON.stringify(twice));
  // Global regexes are rebuilt per call; a shared `g` regex would desync here.
  eq("repeat: DOT/FAA #1", matchDepartment("DOT/FAA"), "DOT");
  eq("repeat: DOT/FAA #2", matchDepartment("DOT/FAA"), "DOT");
  eq("repeat: DOT/FAA #3", matchDepartment("DOT/FAA"), "DOT");
}

/* ────────────────────────────────────────────────────────────────────────────
 * 20. THE REAL SHEET — all 71 rows of Pipeline_2026.xlsx
 *
 * Fixture: scripts/fixtures/pipeline-2026-rows.json, captured verbatim from the
 * "Pipeline" sheet. NOTE THE GEOMETRY: the header is in ROW 2 (row 1 is a merged
 * "AJACE Pipeline_2026" banner) and data starts at ROW 3. Column 2 is
 * "Agency/POC", column 6 is "Description". The row numbers below are real sheet
 * row numbers so they can be looked up in Excel directly.
 * ──────────────────────────────────────────────────────────────────────────── */
{
  const here = dirname(fileURLToPath(import.meta.url));
  const fixturePath = join(here, "fixtures", "pipeline-2026-rows.json");

  // The fixture is a verbatim capture of the operator's workbook and holds real
  // procurement officers' email addresses and phone numbers, so it is
  // gitignored and will simply be absent on a fresh clone or on the box. Skip
  // this section rather than crashing the whole suite: the ~200 synthetic cases
  // above are the portable regression guard, and this section is the extra
  // confidence that comes from the real corpus when it happens to be present.
  if (!existsSync(fixturePath)) {
    console.log(
      "\n20. THE REAL SHEET — SKIPPED (scripts/fixtures/pipeline-2026-rows.json absent).\n" +
      "    Regenerate locally from Pipeline_2026.xlsx to run these 71 cases.",
    );
  } else {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    rows: Array<{ row: number; agency: string; description: string }>;
  };

  /**
   * Expected matchDepartment(Agency/POC) per sheet row. Rows not listed expect
   * null — that is the correct answer for most of this pipeline, which is full
   * of GSA, DOJ, NSF, HUD, state and school-district buyers.
   */
  const AGENCY_EXPECT: Record<number, DepartmentCode> = {
    3: "DOT",   // "DOT/FAA"
    6: "DOI",   // "The U.S. Department of the Interior … Herndon, VA 20170 …"
    11: "HHS",  // "Department of Health and Human Services / HRSA"
    16: "VA",   // "Department of Veterans Affairs … avery.gorman@va.gov"
    17: "DOI",  // "Department of the Interior … ibc.doi.gov"
    32: "DOI",  // "DOI / Daniel Vinson / Department of the Interior"
    49: "DOT",  // "Department of Transportation / FMCSA"
    63: "HHS",  // "NCHS … amr7@cdc.gov"
    67: "DOT",  // no agency name at all — carried by dana.whitfield.ctr@dot.gov
    69: "DOT",  // "DOT/FTA"
    70: "DOT",  // "Department of Transportation / Federal Highway Administration"
    71: "HHS",  // "Department of Health and Human Services / ASFR"
    72: "DOT",  // "FHWASmallBusiness@dot.gov" — glued acronym, domain carries it
  };

  /**
   * Expected departmentForOpportunity(Agency/POC, Description) per sheet row.
   * Everything in AGENCY_EXPECT carries over; these are the rows the
   * description fallback changes. In production the second argument is the
   * opportunity TITLE (src/lib/crawl/pipeline.ts:118,
   * src/app/api/targeting/rescore/route.ts:112) — for these MRAS rows the title
   * is the description's first line, which is exactly where the customer is
   * named ("DOT - Technology Transfer Program - MRAS"), so passing the whole
   * description here is the stricter test, not a laxer one.
   *
   * THE FOUR RECOVERIES (finding #11). All four are GSA eBuy / MRAS notices
   * whose agency column is the market-research desk and whose real customer is
   * named only in the description. Before the fallback widened they were filed
   * null — 5.6% of the pipeline invisible in the department filter.
   */
  const OPPORTUNITY_EXPECT: Record<number, DepartmentCode> = {
    ...AGENCY_EXPECT,
    48: "HHS",  // "HHS ACF - Data Analytics Support - MRAS"
    50: "DOT",  // "DOT - Technology Transfer Program - MRAS / FTA is seeking …"
    58: "DOI",  // "DOI - Secure AI Assistant for Final Agency Decisions - MRAS"
    64: "DOE",  // "Department of Energy EIA - IT Service Desk Support - MRAS"
  };

  /*
   * ROWS WHOSE CORRECT ANSWER IS DEBATABLE — the call made, and why.
   *
   *  rows 7 and 45  → null, NOT DOE. Both are New York City Department of
   *      EDUCATION solicitations. Row 7's description literally reads
   *      "Department of Education (DOE)"; row 45's reads "the security of DOE's
   *      expansive technology environment" with no education word anywhere in
   *      the description — it is only recoverable from the agency block's
   *      tbenne2@schools.nyc.gov. That is precisely why the fallback matches
   *      agency AND description together instead of the description alone.
   *      Calling these Energy would be a confident false positive on 2.8% of
   *      the pipeline.
   *
   *  row 26  → null. "DHA/JPC" is the Defense Health Agency's Joint Pathology
   *      Center — DoD, not HHS, despite "Health" in the name.
   *
   *  row 9   → null. "Louisiana Department of Health" is a STATE health agency.
   *
   *  row 57  → null. "Department of ED" at ed.gov is the Department of
   *      Education — not one of the five, and specifically not DOE=Energy.
   *
   *  row 63  → HHS. NCHS is the National Center for Health Statistics and the
   *      POC is @cdc.gov; both routes agree, so this is not really debatable,
   *      but it is the only row that leans on a sub-agency acronym alone.
   *
   *  rows 24/36/39/40/41/52/53/54/55/62 → null. Also GSA rows, but the customer
   *      named in each description (FTC, USITC, FMCS, NMB, USACE, NIGC, GCERC,
   *      USDA/FSIS) is not one of the five. The widened fallback must not
   *      invent a department for them, and does not.
   */

  eq("sheet: fixture has all 71 data rows", fixture.rows.length, 71);

  const agencyTally: Record<string, number> = { DOT: 0, DOI: 0, DOE: 0, VA: 0, HHS: 0, null: 0 };
  const oppTally: Record<string, number> = { DOT: 0, DOI: 0, DOE: 0, VA: 0, HHS: 0, null: 0 };

  for (const { row, agency, description } of fixture.rows) {
    const gotAgency = matchDepartment(agency);
    const wantAgency = AGENCY_EXPECT[row] ?? null;
    eq(`sheet row ${row}: matchDepartment(Agency/POC)`, gotAgency, wantAgency);
    agencyTally[gotAgency ?? "null"]++;

    const gotOpp = departmentForOpportunity(agency, description);
    const wantOpp = OPPORTUNITY_EXPECT[row] ?? null;
    eq(`sheet row ${row}: departmentForOpportunity(agency, description)`, gotOpp, wantOpp);
    oppTally[gotOpp ?? "null"]++;
  }

  console.log("\n  Agency/POC column alone      :", JSON.stringify(agencyTally));
  console.log("  Agency + Description together:", JSON.stringify(oppTally));

  // Pin the tallies so a future change that quietly re-files rows is caught even
  // if someone edits the per-row expectations above.
  eq("sheet tally (agency only)", JSON.stringify(agencyTally),
    JSON.stringify({ DOT: 6, DOI: 3, DOE: 0, VA: 1, HHS: 3, null: 58 }));
  eq("sheet tally (agency + description)", JSON.stringify(oppTally),
    JSON.stringify({ DOT: 7, DOI: 4, DOE: 1, VA: 1, HHS: 4, null: 54 }));
  }  // end: fixture present
}

// ── 21. HAND-TYPED SPELLINGS: ABBREVIATIONS, SPACING, TYPOS ──────────────────
/**
 * The user TYPES THESE ROWS IN BY HAND, so informal spellings are the norm.
 * Before this section existed, TOKEN_VARIANTS covered five word families and
 * nothing else: every sub-agency abbreviation outside that table failed, the
 * separator between tokens was a MANDATORY run of whitespace (so a missing or
 * extra space around an abbreviation's period failed), and a one-letter slip in
 * "Department" — the most-typed word in the corpus — dropped the row out of the
 * filter entirely for DOT, DOI and DOE, which own no short alias.
 */
{
  table("abbrev/sub-agency", [
    ["Fed. Aviation Administration", "DOT"],
    ["Fed Aviation Admin", "DOT"],
    ["Natl Highway Traffic Safety Administration", "DOT"],
    ["Nat'l Highway Traffic Safety Admin.", "DOT"],
    ["Volpe Natl Transportation Systems Ctr", "DOT"],
    ["Oak Ridge Natl Laboratory", "DOE"],
    ["Natl Nuclear Security Admin.", "DOE"],
    ["Nat'l Institutes of Health", "HHS"],
    ["Ctrs for Disease Control", "HHS"],
    ["Ctr for Medicare and Medicaid Svcs", "HHS"],
    ["Veterans Hlth Administration", "VA"],
    ["Bureau of Land Mgmt", "DOI"],
    ["Bur. of Ocean Energy Mgmt", "DOI"],
    // The Seaway corporation, both legal names and both "Saint" spellings.
    ["St Lawrence Seaway Development Corporation", "DOT"],
    ["Great Lakes St. Lawrence Seaway Development Corp.", "DOT"],
  ]);

  // Spacing around an abbreviation's period is optional on BOTH sides.
  table("abbrev spacing", [
    ["Dept. of Transportation", "DOT"],
    ["Dept of Transportation", "DOT"],
    ["Dept.of Transportation", "DOT"],
    ["Dept . of Transportation", "DOT"],
    ["Dep't of Transportation", "DOT"],
    ["U.S. Dept. of Transportation", "DOT"],
    ["Dept of Energy", "DOE"],
    ["Dept. of the Interior", "DOI"],
  ]);
  // …but the period is the only thing that may replace the space.
  eq("abbrev spacing: 'Deptof Transportation' is still not a department",
    matchDepartment("Deptof Transportation"), null);

  // Procurement portals serve HTML; the entity arrives undecoded in the paste.
  table("html entities", [
    ["Health & Human Services", "HHS"],
    ["Health &amp; Human Services", "HHS"],
    ["Department of Health &amp; Human Services", "HHS"],
    ["Ctrs for Medicare &amp; Medicaid Services", "HHS"],
  ]);

  // Misspellings of "Department" resolve at the FULL-NAME stage, which is what
  // keeps them outranking a stray acronym elsewhere in the same cell.
  table("department misspellings", [
    ["Deptartment of Transportation", "DOT"],
    ["Departmant of Transportation", "DOT"],
    ["Deparment of Transportation", "DOT"],
    ["Departement of Energy", "DOE"],
    ["Deptartment of Veterans Affairs", "VA"],
  ]);
  eq("misspelt department still matches via full-name, not acronym",
    matchDepartmentDetail("Deptartment of Transportation")?.via, "full-name");

  // A misspelt DEPARTMENT NAME falls to the typo-tolerant last stage.
  table("name typos (fuzzy stage)", [
    ["Department of Transportaton", "DOT"],
    ["Department of Transportatoin", "DOT"],
    ["Department of Enegry", "DOE"],
    ["Department of the Interor", "DOI"],
    ["Department of Veterans Afairs", "VA"],
  ]);
  eq("a typo'd name is reported as the weakest evidence there is",
    matchDepartmentDetail("Department of Transportaton")?.via, "fuzzy-name");
  eq("an EXACT name never reaches the fuzzy stage",
    matchDepartmentDetail("Department of Transportation")?.via, "full-name");

  /**
   * The fuzzy stage is the one addition here that could invent a department, so
   * it is pinned hard: one edit, one token, minimum six characters, same first
   * letter, jurisdiction guard still live, and it never runs at all unless every
   * exact stage came back empty.
   */
  table("fuzzy stage must not invent a department", [
    // Sibling cabinet departments are NOT one edit from ours.
    ["Department of Education", null],
    ["Department of Educaton", null],
    ["Departments of Education", null],
    ["Department of Commerce", null],
    ["Department of Defense", null],
    ["Department of Justce", null],
    ["Department of Labor", null],
    ["Department of State", null],
    ["Department of the Treasury", null],
    ["Department of Agriculture", null],
    ["Department of Homeland Security", null],
    ["Education Department", null],
    ["Commerce Department", null],
    ["Fed. Bureau of Investigation", null],
    ["Natl Science Foundation", null],
    ["Nat'l Aeronautics and Space Admin.", null],
    ["Bureau of Labor Statistics", null],
    ["Federal Reserve Bank of New York", null],
    // Short structural words are never fuzzed: "of" must not become "or".
    ["Department or Transportation", null],
    // The jurisdiction guard survives a typo.
    ["Virginia Deptartment of Transportation", null],
    ["Guam Deptartment of Transportation", null],
    ["Navajo Nation Dept of Transportation", null],
    ["Minnesota Dept. of Transportation", null],
    ["North Carolina Deptartment of Health and Human Services", null],
    // The new word families must not fire outside a complete name.
    ["Fed funds rate analysis", null],
    ["ENERGY STAR certified equipment refresh", null],
    ["Bureau of Land Records for the County Assessor", null],
    ["Configuration management database and asset mgmt tooling", null],
    ["Laboratory information management system for a university", null],
  ]);

  // The typo-tolerant stage walks the SAME name lists as stage 1, so it has to
  // honour PARENT_REQUIRED_NAMES as well — otherwise it reopens the generic
  // office-title hole one misspelling at a time, and GSA's or NASA's "Office of
  // Informaton and Technology" lands under Veterans Affairs.
  eq("fuzzy stage honours PARENT_REQUIRED_NAMES",
    matchDepartment("Office of Informaton and Technology"), null);
  eq("…and the abbreviation folding survives the parent-named form",
    matchDepartment("Dept. of Veterans Affairs, Office of Info. and Technology"), "VA");
}

// ── 22. FULL NAMES THAT ARE NOT SELF-SUFFICIENT ──────────────────────────────
/**
 * Stage 1 outranks every acronym and every domain, so a weak entry in a
 * full-name list beats an explicitly named DIFFERENT agency and nothing
 * downstream can undo it. Two entries were weak in exactly that way.
 *
 *   · VA's "Office of Information and Technology" is a generic office title —
 *     GSA, DOJ, NASA, Amtrak and any university have one by the same name, and
 *     every one of them was being filed under Veterans Affairs.
 *   · DOI's "Geological Survey" and "Interior Business Center" are ordinary
 *     English phrases, and phraseRegex() is case-insensitive, so "perform a
 *     geological survey of the corridor" was read as the Department of the
 *     Interior. "National Park Service" had the same lower-case-prose hole.
 *
 * Both halves of each pair matter: the REJECT cases are the bug, the ACCEPT
 * cases are the false negatives a naive "just delete the entry" fix would have
 * introduced instead.
 */
{
  table("generic office title — rejected without its parent", [
    ["General Services Administration, Office of Information and Technology", null],
    ["Department of Justice Office of Information and Technology", null],
    ["NASA Office of Information and Technology", null],
    ["Amtrak Office of Information and Technology", null],
    ["Rutgers University Office of Information and Technology", null],
    // A bare office title names nobody, and null is the honest answer.
    ["Office of Information and Technology", null],
    // The postal "VA" is not corroboration: acceptVA rejects a comma-led place
    // slot, and hasDepartmentCorroboration now runs that same guard.
    ["GSA Office of Information and Technology, Reston, VA", null],
  ]);

  table("generic office title — still matches when VA is named", [
    ["VA Office of Information and Technology (OI&T)", "VA"],
    ["Department of Veterans Affairs, Office of Information and Technology", "VA"],
    ["Office of Information and Technology, oit@va.gov", "VA"],
    ["Office of Information Technology, VA", "VA"],
  ]);

  // The abbreviation folding still reaches the sub-agency name itself: with VA
  // corroborated by domain only, the match must come from the NAME, not from
  // the domain stage. This is what the old bare "Office of Info. and Technology"
  // fixture was really testing.
  const abbrev = matchDepartmentDetail("Office of Info. and Technology, oit@va.gov");
  eq("abbrev reaches the sub-agency name, not just the domain", abbrev?.via, "full-name");
  eq("abbrev matched phrase", abbrev?.matched, "Office of Information and Technology");

  table("bureau name vs the ordinary English phrase — prose rejected", [
    ["Contractor shall perform a geological survey of the pipeline corridor", null],
    ["perform a geological survey and wetlands delineation", null],
    ["environmental review including a geological survey", null],
    ["Building interior business center renovation", null],
    ["the national park service road repaving", null],
    // The fuzzy stage must not reopen the door stage 1 just closed.
    ["Contractor shall perform a geologicel survey of the corridor", null],
  ]);

  table("bureau name vs the ordinary English phrase — the real bureau still matches", [
    ["Geological Survey", "DOI"],
    ["U.S. Geological Survey", "DOI"],
    ["United States Geological Survey, Reston", "DOI"],
    // Hand-typed cells arrive in every casing, including ALL CAPS.
    ["GEOLOGICAL SURVEY", "DOI"],
    ["INTERIOR, DEPARTMENT OF THE - GEOLOGICAL SURVEY", "DOI"],
    ["Interior Business Center", "DOI"],
    ["Interior Business Center (IBC) payroll shared services", "DOI"],
    ["National Park Service", "DOI"],
    ["National Park Service - Yellowstone", "DOI"],
    ["The National Park Service is seeking a campground reservation platform", "DOI"],
  ]);

  // A prose rejection is NOT `blocked`: prose proves nothing about any
  // department, so the later stages must still be free to run.
  table("prose rejection does not suppress the later stages", [
    ["perform a geological survey; contact rodriguez@doi.gov", "DOI"],
    ["building interior business center work for USGS", "DOI"],
  ]);
}

if (failures.length) {
  console.error(`\n${failures.length} failing assertion(s) above.`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
