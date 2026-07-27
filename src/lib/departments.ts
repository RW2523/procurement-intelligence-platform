/**
 * The five priority departments (DOT, DOI, DOE, VA, HHS) and the matcher that
 * assigns `opportunities.department` from free-text agency strings.
 *
 * WHY THIS IS NOT A `.includes()` CALL. The agency field in this system is a
 * hand-typed contact block, not a clean code. A real row from the user's
 * spreadsheet reads:
 *
 *     "The U.S. Department of the Interior
 *      381 ELDEN STREET, SUITE 4000
 *      Herndon, VA 20170
 *      MARGUERITE RODRIGUEZ ..."
 *
 * A naive acronym scan returns VA (Veterans Affairs) for a Department of the
 * Interior solicitation, because "VA" there is the postal abbreviation for
 * Virginia. That single misread would put an Interior pursuit under the wrong
 * department filter and hand it the wrong scoring priority. So the matcher is
 * built around these rules, in this order:
 *
 *   1. Strip postal addresses ("<CITY>, XX 12345") before anything else.
 *   2. FULL NAMES WIN. If any department's full name (or one of its bureaus'
 *      full names) appears, a stray acronym elsewhere in the string can never
 *      override it. That precedence is why a WEAK entry in a full-name list does
 *      more damage than a weak acronym — it beats an explicitly named different
 *      agency — so the two weak shapes carry guards of their own: see FULL NAMES
 *      THAT ARE NOT SELF-SUFFICIENT below. Full names are matched through
 *      phraseRegex(), which knows
 *      that "Department" is also written "Dept."/"Dept", that "Administration"
 *      is also "Admin.", that "National" is also "Natl"/"Nat'l", and that "and"
 *      is also "&"/"&amp;" — so the abbreviation and ampersand spellings are
 *      handled ONCE, for every list, instead of being pasted into each list by
 *      hand. See TOKEN_VARIANTS.
 *   3. Acronyms are matched CASE-SENSITIVELY and word-bounded, so "doi.gov",
 *      "template.dot" and lower-case prose never fire. This mirrors the
 *      convention already used by phraseRegex() in src/lib/targeting/engine.ts.
 *      The PERIOD-SEPARATED spelling of a plain initialism is derived by
 *      acronymRegex(), not listed: "D.O.T.", "H.H.S.", "D.H.H.S." and
 *      "U.S.D.O.T." all match from the ordinary "DOT"/"HHS"/"DHHS"/"USDOT"
 *      entries, and "U.S.DOT" survives the filename guard by way of
 *      DOTTED_INITIALISM_BEFORE. Do not paste dotted literals into the lists.
 *   4. A DEPARTMENT-level acronym owned by a state, territory, county, tribal
 *      nation or city is rejected ("Virginia DOT", "NY DOT", "Mn/DOT", "Orange
 *      County DOT", "Chicago DOE"). Rule 2's jurisdiction check can only fire on
 *      a string that spells the full name out, and state rows usually do not. At
 *      state level these acronyms often mean something else entirely: DOE is the
 *      Department of Education, DOI the Department of Insurance.
 *   5. Ambiguous acronyms carry an explicit accept() guard — "VA" (Virginia),
 *      "DOE" (Education), "DOI" (digital object identifier) — and every acronym
 *      is additionally rejected when it is being CITED AS A STANDARD rather than
 *      named as a buyer ("FAA-compliant", "49 CFR DOT", "NIH Stroke Scale").
 *   6. Collision-prone SUB-agency acronyms (CMS, CDC, NPS, IHS, FRA, FTA, BIA…)
 *      require corroboration — see COLLISION-PRONE ACRONYMS below.
 *   7. Only if all of that finds nothing, fall back to the .gov domain in the
 *      POC's email — many rows are a bare contact block with no agency name.
 *   8. Only if THAT finds nothing either, retry the full names allowing ONE
 *      misspelt token ("Department of Transportaton"). Last, weakest, and
 *      unreachable whenever any earlier rule produced an answer — see the
 *      "Typo tolerance" section.
 *
 * Every rule here was checked against the real 71-row Pipeline_2026 sheet, not
 * invented: see scripts/test-departments.mts, whose fixtures are drawn from it.
 *
 * COLLISION-PRONE ACRONYMS — READ BEFORE WIDENING ANY ACRONYM LIST.
 * This corpus is NAICS 541511 / 54151S / 518210C: custom software and IT
 * services. In that vocabulary "CMS" is a Content or Contract Management System
 * far more often than the Centers for Medicare & Medicaid Services; "NPS" is a
 * Net Promoter Score; "CDC" is CDC Software the ERP vendor; "IHS" is IHS Markit;
 * "FRA" is a Financial Reporting Application; "FTA" is a Free Trade Agreement;
 * "BIA" is a Business Impact Analysis; "OSM" is OpenStreetMap; "SRS" is a
 * Software Requirements Specification (which is why SRS is not listed at all).
 * Those acronyms are marked `needsCorroboration`.
 * FAA, FMCSA, NHTSA, FHWA, PHMSA, MARAD, NIH, FDA, HRSA, SAMHSA, AHRQ, BLM,
 * USGS, BSEE, BOEM, VHA, VBA and the DOE national-laboratory acronyms have no
 * competing civilian meaning in procurement text and are safe alone. Do NOT
 * "helpfully" move an acronym out of the corroboration list without a corpus
 * reason — a false positive files a pursuit under a department it has nothing
 * to do with, and the user never sees it in the right filter.
 *
 * MISSION VOCABULARY — THE SECOND WAY TO CORROBORATE, AND WHY IT IS REQUIRED.
 * Corroboration used to mean ONE thing: the PARENT department named in the same
 * text. That is not how federal notices are written. Inside the government the
 * parent is implicit, so an operating division names only itself — "CMS
 * Interoperability and Prior Authorization API", "NPS park pass e-commerce
 * platform", "IHS Albuquerque Area Office", "FTA Section 5307 transit grant",
 * "FRA Office of Railroad Safety", "BIA Office of Justice Services", "CDC
 * National Syndromic Surveillance Program". Not one of those spells out HHS,
 * DOI or DOT anywhere, so parent-only corroboration returned null for every one
 * of them: the WORST failure mode this module has, because the user's pursuit
 * silently vanishes from the filter they asked for rather than showing up in the
 * wrong one.
 *
 * So a collision-prone acronym is ALSO corroborated by `corroboratedBy`: subject
 * matter that only that bureau buys. Medicare/Medicaid/prior authorization for
 * CMS; national park/campground/trailhead for NPS; child support/Head Start/TANF
 * for ACF; railroad/grade crossing/Amtrak for FRA; transit/Section 53xx for FTA.
 * This is deliberately the bureau's MISSION, never its org chart or its generic
 * IT verbs — "management system", "modernization", "data platform" and
 * "analytics" appear on both sides of the line and would re-open the exact
 * false positives the corroboration rule exists to close. The reject cases in
 * scripts/test-departments.mts §7d (Content Management System, Net Promoter
 * Score, IHS Markit, Free Trade Agreement, Business Impact Analysis, CDC
 * Software, OpenStreetMap, Environmental Impact Assessment) are the fixed cost
 * of any widening here: run them before adding a term.
 *
 * Mission vocabulary does NOT bypass the other guards. isRegulatoryCitation()
 * still runs first, so "CMS certification required" on a state Medicaid MMIS is
 * still rejected as a cited standard rather than read as the buyer.
 *
 * This module is PURE (no "server-only", no I/O) so it can be imported by the
 * crawl pipeline, the rescore route, a client-side filter dropdown, and the
 * test at scripts/test-departments.mts alike.
 */

export type DepartmentCode = "DOT" | "DOI" | "DOE" | "VA" | "HHS";

export interface DepartmentDef {
  code: DepartmentCode;
  /** Human label for dropdowns and badges. */
  label: string;
  /** Canonical full name. */
  name: string;
  /**
   * Full-name forms of the department itself. Matched case-INSENSITIVELY and
   * word-bounded through phraseRegex(), and rejected when preceded by a
   * state/city/county/tribal jurisdiction (see JURISDICTION_PREFIX) so
   * "Virginia Department of Transportation" is not read as the federal DOT.
   *
   * You do NOT need to list "Dept." / "Dept" / "&" variants — phraseRegex()
   * derives them. You DO need to list SAM.gov's INVERTED form
   * ("Transportation, Department of") as a literal alias:
   * src/lib/connectors/sam.ts:93 builds `agency` from `fullParentPathName`,
   * which is inverted for every federal row, so without these
   * "ENERGY, DEPARTMENT OF · OFFICE OF SCIENCE" matches nothing at all. They are
   * aliases rather than a text rewrite on purpose: a rewrite rule broad enough
   * to catch them also mangles "MARGUERITE RODRIGUEZ, Department of the
   * Interior" into a string where the department no longer appears.
   *
   * The inverted NEWS styling ("Transportation Department", "Energy Dept.") is
   * listed here too — wire-service and trade-press copy is pasted into these
   * cells verbatim.
   */
  fullNames: string[];
  /** Full names of operating administrations / bureaus that roll up here. */
  subAgencyNames: string[];
  /** Acronyms for the department. Matched case-SENSITIVELY. */
  acronyms: AcronymRule[];
  /** Acronyms of sub-agencies that roll up here. Matched case-SENSITIVELY. */
  subAgencyAcronyms: AcronymRule[];
  /**
   * Official .gov domains, matched in the POC block's email/URL as a LAST
   * resort. Real rows in the sheet carry no agency name at all — row 67 is
   * nothing but "Dana Whitfield / dana.whitfield.ctr@dot.gov" — and the domain
   * is the only evidence present.
   */
  domains: string[];
}

/** ~80 characters either side of an acronym hit, plus the whole cleaned text. */
export interface AcronymContext {
  /** The ~80 characters before the hit. */
  before: string;
  /** The ~80 characters after the hit. */
  after: string;
  /** EVERYTHING before the hit. Use this for jurisdiction tests, which are
   *  anchored at the end and need a real start-of-string to reason about. */
  beforeAll: string;
  /** The whole (address-stripped) text. */
  full: string;
  /** Start offset of the hit in `full`. Equal to `beforeAll.length`. */
  start: number;
  /** End offset of the hit in `full` (exclusive). */
  end: number;
}

export interface AcronymRule {
  term: string;
  /** Extra guard for ambiguous terms. Return false to reject and keep looking. */
  accept?: (ctx: AcronymContext) => boolean;
  /**
   * Set only when reaching this point is itself POSITIVE PROOF of federal
   * ownership. Such a rule opts out of the generic state/local jurisdiction
   * guard (isJurisdictionOwnedAcronym), which would otherwise veto it.
   *
   * TWO KINDS OF RULE QUALIFY.
   *
   * (a) The TERM is federal on its face: "USDOT", "US DOT", "U.S. DOT",
   *     "USDOI", "USDOE". No state, county or city abbreviates ITSELF that way,
   *     so a jurisdiction earlier in the cell cannot own it — "Virginia
   *     Department of Transportation coordinating with USDOT" names the federal
   *     department outright, and vetoing it deletes the row from the filter.
   *
   * (b) accept() ITSELF proved it. "VA" is the one rule of this kind: the DC VA
   *     Medical Center and the Minneapolis VA Medical Center are federal
   *     facilities whose names put a jurisdiction immediately before the
   *     acronym, and acceptVA() runs the jurisdiction guard ITSELF on its weaker
   *     accept paths, so only its veterans-specific evidence bypasses it.
   *
   * Bare "DOT"/"DOI"/"DOE" are neither: every state owns one. Their accept()s
   * are rejections of noise (John Doe, doi:10.…, school districts) that prove
   * nothing, so those rules do NOT set this.
   *
   * The flag is checked AFTER accept() and after the state-restatement test, so
   * it can only bypass the GENERIC jurisdiction guard — "USDOE school district
   * curriculum portal" is still rejected by acceptDOE().
   */
  provesFederal?: boolean;
  /**
   * The acronym has a common non-government meaning in a 541511 IT-services
   * corpus. It only matches when the same text independently names its parent
   * department (full name, department acronym, or .gov domain) OR carries this
   * bureau's own MISSION VOCABULARY (`corroboratedBy`). See the COLLISION-PRONE
   * ACRONYMS note at the top of this file.
   */
  needsCorroboration?: boolean;
  /**
   * Second, independent way to satisfy `needsCorroboration`: subject matter that
   * only this bureau buys. See MISSION VOCABULARY at the top of this file.
   *
   * Must be a NON-global regex — it is `.test()`ed repeatedly and `g` would make
   * it stateful. It must also be narrow enough that the acronym's civilian
   * homonym never drags it in: "Medicare" rescues CMS, "management system" must
   * not.
   */
  corroboratedBy?: RegExp;
  /**
   * A NAMED commercial entity whose brand IS this acronym. Decisive negative
   * evidence: it vetoes the acronym outright, ahead of `corroboratedBy`.
   *
   * Only for proper nouns, never for subject matter. "IHS Markit" and "CDC
   * Software" are companies — the module's own COLLISION-PRONE note names both —
   * and their notices freely say "tribal" or "public health" for reasons that
   * have nothing to do with the Indian Health Service or the Centers for Disease
   * Control. Without this, mission vocabulary anywhere in the row rescues them.
   */
  civilianHomonym?: RegExp;
}

/**
 * Has the TEXT ITSELF defined this acronym as something else, right where it is
 * used? "Content Management System (CMS)", "Business Impact Analysis (BIA)",
 * "Free Trade Agreement (FTA)", "OpenStreetMap (OSM)". A parenthetical gloss
 * whose initials spell the acronym is the author telling us what they mean, and
 * it outranks any mission word elsewhere in the row.
 *
 * SAFE BY CONSTRUCTION for the real bureaus. If the gloss were the genuine name
 * ("National Park Service (NPS)", "Federal Transit Administration (FTA)",
 * "Centers for Medicare & Medicaid Services (CMS)"), Stage 1's full-name scan
 * would have matched and returned before Stage 2 ever ran — this function is
 * only ever reached once the official name is known to be absent. That is why it
 * can reject on the gloss shape alone without a whitelist.
 *
 * `before` is the ~80-char window, which is ample: a gloss sits immediately in
 * front of its acronym.
 */
const GLOSS_OPEN = /[("'‘“[]\s*$/;

export function isGlossedAsSomethingElse(term: string, before: string): boolean {
  if (!GLOSS_OPEN.test(before)) return false;
  const words = before.replace(GLOSS_OPEN, "").match(/[A-Za-z][A-Za-z'&.-]*/g);
  if (!words?.length) return false;
  const letters = term.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (letters.length < 2) return false;
  // (i) One word per letter: "Business Impact Analysis" → BIA.
  const tail = words.slice(-letters.length);
  if (
    tail.length === letters.length &&
    tail.map((w) => w[0]).join("").toUpperCase() === letters
  ) {
    return true;
  }
  // (ii) One CamelCase token carrying the initials: "OpenStreetMap" → OSM.
  const caps = words[words.length - 1].match(/[A-Z]/g);
  return !!caps && caps.join("") === letters;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Ambiguity guards
 * ──────────────────────────────────────────────────────────────────────────── */

const US_STATE_CODES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|" +
  "MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|PR|RI|SC|SD|TN|TX|UT|VT|VA|VI|WA|WV|WI|WY";

/**
 * "VA" inside a run of postal abbreviations: "VA, MD, DC", "Ship to: VA / NC /
 * SC", "MD/VA/DC region". The neighbour must be a REAL postal code, otherwise
 * "VA/OI&T" (Veterans Affairs Office of Information & Technology) would be
 * thrown away with them.
 */
const POSTAL_RUN_AFTER = new RegExp(`^\\s*[,/|]\\s*(?:${US_STATE_CODES})(?![A-Za-z])`);
const POSTAL_RUN_BEFORE = new RegExp(`(?<![A-Za-z])(?:${US_STATE_CODES})\\s*[,/|]\\s*$`);

/**
 * Evidence that the string is talking about the Commonwealth of Virginia. Any
 * of this present and a bare "VA" is the state, not the department — unless the
 * hit already cleared one of acceptVA()'s hard-positive tests above.
 */
const VIRGINIA_STATE_EVIDENCE = /\bVirginia\b|\bVA\s+Beach\b|(?<![A-Za-z0-9])virginia\.gov/i;

/**
 * "VA DOT", "VA DEQ" — the acronym is qualifying ANOTHER agency acronym, which
 * makes it the state prefix, not the department. Built from the department
 * acronyms this file already knows plus the state-agency acronyms that show up
 * next to a state postal code in this corpus.
 */
const STATE_AGENCY_ACRONYM_AFTER =
  /^\s+(?:DOT|DOE|DOI|DOC|DOA|DOH|DEQ|DEP|DGS|DMV|DSS|DHR|DBHDS|VDOT|HHS|ABC|EDA)\b/;

/**
 * Organisational words that legitimately END the name in front of ", VA" —
 * "Office of Information Technology, VA", "Contracting Office, VA". A CITY name
 * in that slot ("…, Richmond, VA") is a postal address and is rejected instead.
 *
 * THIS TEST IS NOT SUFFICIENT ON ITS OWN. Most of these words are ordinary
 * COMMERCIAL vocabulary — "Leidos Digital Solutions Group", "Enterprise
 * Services", "Network Operations Center", "Advanced Technology" — and a company
 * name ending in one of them followed by the Virginia postal code is the single
 * most ordinary string in a Northern Virginia contracting corpus. Matching on
 * the tail word alone filed every one of them under Veterans Affairs. So the
 * tail word is only half the rule; see isGovernmentOrgTail().
 */
const ORG_TAIL_BEFORE =
  /\b(?:Office|Administration|Department|Division|Service|Services|Center|Centre|Command|Agency|Bureau|Directorate|Program|Programme|Branch|Group|Technology|Acquisition|Contracting|Procurement|Logistics|Affairs|Network|System)\s*[,–—-]\s*$/i;

/**
 * A word that only a GOVERNMENT body puts in its own name. Requiring one of
 * these somewhere in the same name segment is what separates "Contracting
 * Office, VA" and "Office of Information Technology, VA" (accept) from "Leidos
 * Digital Solutions Group, VA" and "Advanced Technology, VA" (reject) — both of
 * which end in an ORG_TAIL_BEFORE word and neither of which is the department.
 */
const GOV_ORG_HEAD =
  /\b(?:Office|Administration|Department|Depts?|Dep't|Directorate|Bureau|Agency|Commission|Command|Secretariat|Contracting|Acquisition|Procurement)\b/i;

/**
 * True when the text immediately before ", VA" is the name of a GOVERNMENT body
 * rather than a company or a city.
 *
 * Only the LAST comma/newline-delimited segment is inspected. A government word
 * further back ("Department of Veterans Affairs, c/o Acme Solutions Group, VA")
 * belongs to a different segment and must not vouch for this one.
 */
function isGovernmentOrgTail(before: string): boolean {
  if (!ORG_TAIL_BEFORE.test(before)) return false;
  const segment = before.replace(/\s*[,;:–—-]\s*$/, "").split(/[,;:|\r\n]/).pop() ?? "";
  return GOV_ORG_HEAD.test(segment);
}

/**
 * Department/sub-agency SLASH notation: "VA/OI&T", "DOT / VA", "HHS/VA".
 *
 * The token on the other side of the slash must look like an ACRONYM — an
 * upper-case run, not a capitalised word. Accepting any slash at all turned
 * every slash-separated LOCATION LIST into Veterans Affairs ("Arlington, VA /
 * Bethesda, MD", "Chantilly, VA/ Herndon, VA", "Reston, VA | Columbia, MD"):
 * POSTAL_RUN_AFTER only catches the case where the next token is a bare postal
 * code, and people write these lists with CITY names.
 */
const ORG_NOTATION_AFTER = /^\s*[/\\|]\s*[A-Z][A-Z0-9&.'-]*[A-Z0-9](?![a-z])/;
const ORG_NOTATION_BEFORE = /(?<![a-z])[A-Z0-9][A-Z0-9&.'-]*\s*[/\\|]\s*$/;

/**
 * "VA" is the postal code for Virginia AND the acronym for Veterans Affairs.
 * Addresses with a ZIP are already stripped before we get here, but "Arlington,
 * VA" (no ZIP) and "…, Richmond VA" are not — so a bare VA is only accepted
 * with positive evidence that a department, not a state, is meant.
 *
 * THE ORDER MATTERS AND IS THE WHOLE DESIGN:
 *   (1) hard federal evidence   → yes, and it outranks every jurisdiction guard
 *   (2) "VA <facility>" naming  → yes, same standing ("DC VA Medical Center")
 *   (3) state / postal evidence → no
 *   (4) weak positional signals → yes, but only after (3) has had its say
 *
 * The previous version accepted on a "medical center"/"veterans" word ANYWHERE
 * in an 80-character window, which labelled every Virginia hospital and every
 * county veterans-services office as the federal department; and it accepted
 * ANY string merely starting with "VA ", which is how "VA Beach City Public
 * Schools" and "VA / NC / SC" were filed under Veterans Affairs. Both of those
 * shortcuts are gone. The lookbehind on va.gov is load-bearing and was found by
 * running this matcher over the real sheet: row 18 is "Department of City of
 * Danville VA / purchasing@danvilleva.gov" — the CITY of Danville, Virginia. A
 * bare /va\.gov/ matches inside "danvilleva.gov".
 */
const acceptVA: AcronymRule["accept"] = ({ before, after, beforeAll, full }) => {
  const near = `${before} ${after}`;

  // (1) Vocabulary that ONLY the federal department owns. Note that a bare
  //     "veterans" or "medical center" is deliberately NOT enough — those words
  //     surround every state veterans office and every Virginia hospital.
  if (
    /\bVHA\b|\bVBA\b|\bVISN\b|\bVAMC\b|(?<![A-Za-z0-9])va\.gov|veterans?\s+(?:affairs|health\s+administration|benefits\s+administration|integrated\s+service|canteen)/i.test(
      near,
    )
  ) {
    return true;
  }

  // (2) "VA" directly qualifying a VA facility: "VA Medical Center", "VA Great
  //     Lakes Acquisition Center", "Maryland VA Health Care System". The
  //     facility words must FOLLOW the acronym within a few capitalised tokens.
  //     "Norfolk, VA - Level I Trauma Medical Center" fails here because the
  //     punctuation after "VA" breaks the name, which is exactly the tell.
  if (
    /^\s+(?:[A-Za-z][\w.&'-]*\s+){0,4}(?:Medical\s+Cent(?:er|re)|Health\s*care\s+System|Health\s+System|Hospital|Outpatient\s+Clinic|Regional\s+Office|National\s+Cemetery|Acquisition\s+Center|Medical\s+Facility)\b/i.test(
      after,
    )
  ) {
    return true;
  }

  // (3) Rejections. A postal run, the Commonwealth by name, a state-agency
  //     acronym being qualified, or a jurisdiction owning the acronym outright.
  if (POSTAL_RUN_AFTER.test(after) || POSTAL_RUN_BEFORE.test(before)) return false;
  if (VIRGINIA_STATE_EVIDENCE.test(full)) return false;
  if (STATE_AGENCY_ACRONYM_AFTER.test(after)) return false;
  if (isJurisdictionOwnedAcronym(beforeAll)) return false;

  // (4) Weak but real signals, in decreasing strength.
  //
  // ORDER WITHIN THIS TIER IS ITSELF LOAD-BEARING. The slash rule used to run
  // FIRST, so it decided "Arlington, VA / Bethesda, MD" before the comma-led
  // place slot below ever got a say — every slash- or pipe-separated location
  // list came back as Veterans Affairs. A comma-led place slot now settles the
  // question first, and the slash rule that follows only fires on genuine
  // acronym notation.
  //
  // "Office of Information Technology, VA" — a GOVERNMENT org name, not a city
  // and not a company, in front.
  if (isGovernmentOrgTail(before)) return true;
  // "…, Reston, VA" / "…, Richmond, VA" / "…Solutions Group, VA" — a comma-led
  // place or company slot. Reject.
  if (/[A-Za-z0-9.'"-]\s*,\s*$/.test(before)) return false;
  // Department/sub-agency notation: "VA/OI&T", "DOT / VA". An acronym on the
  // other side of the slash, never a capitalised city name.
  if (ORG_NOTATION_BEFORE.test(before) || ORG_NOTATION_AFTER.test(after)) return true;
  // The agency string LEADS with it ("VA Great Lakes Acquisition Center", "VA").
  // A postal "…, Arlington VA" never leads, which is exactly the case we reject.
  return beforeAll.trim() === "";
};

/** "DOE" in an ALL-CAPS contact block can be the placeholder surname. */
const REJECT_JOHN_DOE = /\b(?:JOHN|JANE|JOHN\s+Q\.?)\s+$/i;

/**
 * Evidence that an EDUCATION BODY — not the topic of education — owns the "DOE"
 * in this text. At every level below the federal government "DOE" is the
 * Department of EDUCATION: NYC DOE, Chicago DOE, "state DOE certification". Two
 * rows of the user's own pipeline (sheet rows 7 and 45) are New York City
 * Department of Education solicitations whose text says "DOE".
 *
 * DELIBERATELY NARROW, AND THAT IS THE POINT. An earlier version rejected on
 * `\bacademic\b`, `\buniversity\b`, `\bstudents?\b` and a bare `\bschools?\b`
 * anywhere in the text. That is the everyday vocabulary of the DOE OFFICE OF
 * SCIENCE, which funds university and academic research as its core mission and
 * runs STEM workforce programmes for students — so "DOE Office of Science —
 * academic research computing support" and "DOE STEM workforce program for
 * students" were both silently dropped to null. A false negative here is the
 * worst outcome in this module: the user filters on DOE and their own pursuit is
 * simply not there.
 *
 * So the test asks for an INSTITUTION, not a subject: a department/board of
 * education, a school district or named school system, a superintendent, a
 * classroom/pupil/K-12 context, or a school-system email domain. Every entry
 * below names a body that buys, not a field that is studied.
 */
const EDUCATION_EVIDENCE = new RegExp(
  [
    // "Department of Education", "Board of Education", "NY State Education Dept."
    "\\b(?:Departments?|Dept\\.?|Dep't|Boards?|Offices?|Divisions?|Bureaus?|Ministr(?:y|ies))\\s+of\\s+(?:Elementary\\s+and\\s+Secondary\\s+)?Education\\b",
    "\\bEducation\\s+(?:Department|Dept\\.?|Agency|Authority|Commission)\\b",
    // School systems as buying bodies.
    "\\bschool\\s+(?:district|board|system|division|committee|corporation)s?\\b",
    "\\b(?:public|charter|elementary|secondary|middle|high|magnet|parochial|city|county|community|unified|independent|consolidated|regional|area|district)\\s+schools?\\b",
    "\\bsuperintendent\\b",
    "\\bboard\\s+of\\s+(?:regents|trustees)\\s+of\\s+education\\b",
    // Classroom-level context. "students"/"academic"/"university" are NOT here:
    // the DOE Office of Science owns those words too.
    "\\bclassrooms?\\b",
    "\\bpupils?\\b",
    "\\bteachers?\\b",
    "\\bcurriculum\\b",
    "\\bK-?12\\b",
    // NYC DOE's own IT division — sheet row 7 names it and nothing else.
    "\\bDIIT\\b",
    // School-system domains: "tbenne2@schools.nyc.gov" is the ONLY education
    // signal in sheet row 45. Also "…@k12.va.us", "…@dallasisd.org".
    "(?<![A-Za-z0-9])(?:schools|k12)\\.[a-z]",
    "\\.k12\\.[a-z]{2}\\.us(?![A-Za-z0-9])",
    "(?<![A-Za-z0-9])[a-z0-9-]*isd\\.org(?![A-Za-z0-9])",
  ].join("|"),
  "i",
);

/**
 * A gloss attached to the acronym itself: "DOE (Education)", "DOE – Dept. of
 * Education", "DOE: Education". This is a LOCAL test on the text immediately
 * after the hit, because the bare word "Education" on its own is not evidence —
 * see EDUCATION_EVIDENCE above for why that matters.
 */
const EDUCATION_GLOSS_AFTER =
  /^\s*[([{/:,–—-]\s*(?:(?:U\.?S\.?|United\s+States|Federal|State|City|County|NYC)\s+)*(?:(?:Departments?|Dept\.?|Dep't|Boards?|Offices?)\s+of\s+)?Education\b/i;

/**
 * Evidence that the DOE meant here is ENERGY. It outranks the education test, so
 * a genuine Department of Energy notice that also mentions schools or K-12 STEM
 * outreach is not thrown away.
 *
 * This list is deliberately GENEROUS — it can only ever RESCUE a DOE hit that
 * EDUCATION_EVIDENCE wanted to reject, and it cannot rescue a state or city DOE,
 * because isJurisdictionOwnedAcronym() runs separately from and after this
 * guard ("NYC DOE solar array on school roofs" stays null on the jurisdiction
 * rule). The national-lab names and site names matter most: a DOE notice that
 * names Argonne or the Office of Science may never repeat the word "Energy".
 */
const ENERGY_EVIDENCE = new RegExp(
  [
    "\\bEnergy\\b",
    // Programme offices that are DOE's and nobody else's.
    "\\bOffice\\s+of\\s+Science\\b",
    "\\bEnvironmental\\s+Management\\b",
    "\\bScience\\s+and\\s+Technology\\s+Policy\\b",
    // Mission vocabulary.
    "\\bnuclear\\b", "\\bradioactive\\b", "\\bradiological\\b", "\\bisotopes?\\b",
    "\\breactors?\\b", "\\bfusion\\b", "\\bfissile\\b", "\\bplutonium\\b", "\\buranium\\b",
    "\\bgrid\\b", "\\bpower\\s+marketing\\b", "\\bweapons\\s+complex\\b",
    "\\b(?:renewable|solar|wind|hydropower|hydroelectric|fossil|petroleum|hydrogen|geothermal|biofuels?|electricity)\\b",
    // Agencies and programme acronyms.
    "\\b(?:NNSA|EERE|ARPA-E|EIA|SPR|LPO)\\b",
    // National laboratories and sites, by name and by acronym. A DOE notice
    // often names ONLY its site.
    "\\bnational\\s+laborator", "\\bnational\\s+lab\\b",
    "\\b(?:Oak\\s+Ridge|Los\\s+Alamos|Sandia|Argonne|Brookhaven|Livermore|Berkeley\\s+Lab|Fermilab|Fermi\\s+National|Idaho\\s+National|Pacific\\s+Northwest\\s+National|Savannah\\s+River|Hanford|Pantex|Y-12|SLAC|Princeton\\s+Plasma|Ames\\s+Laborator|Jefferson\\s+Lab|Nevada\\s+National\\s+Security)\\b",
    "\\b(?:ORNL|PNNL|LLNL|LBNL|LANL|ANL|BNL|INL|NREL|FNAL|PPPL|NETL|SRNL|SRS)\\b",
    // Its own domains.
    "(?<![A-Za-z0-9])(?:energy|doe|nnsa|eia|ornl|pnnl|llnl|inl|lanl|nrel|anl|bnl|srs)\\.gov(?![A-Za-z0-9])",
  ].join("|"),
  "i",
);

/**
 * "DOE" guard: reject the placeholder surname, and reject the Department of
 * EDUCATION reading. This is the counterpart of acceptVA — without it every
 * school-district row in the sheet resolves to Department of Energy.
 *
 * Applied to BOTH "DOE" and "USDOE". The two spellings previously disagreed —
 * USDOE carried no guard at all — which meant the same text was filed one way or
 * the other purely on how the user happened to abbreviate.
 */
const acceptDOE: AcronymRule["accept"] = ({ before, after, full }) => {
  if (REJECT_JOHN_DOE.test(before)) return false;
  if (ENERGY_EVIDENCE.test(full)) return true;
  if (EDUCATION_GLOSS_AFTER.test(after)) return false;
  if (EDUCATION_EVIDENCE.test(full)) return false;
  return true;
};

/** "DOI:10.1000/…" is a digital object identifier, not the Interior. */
const rejectDigitalObjectId: AcronymRule["accept"] = ({ after }) => !/^\s*:\s*10\.\d/.test(after);

/**
 * An acronym CITED AS A STANDARD is not the buyer. "FAA-compliant drone
 * operations for the City of Austin" is an Austin contract; "49 CFR DOT hazmat
 * training" and "FDA 21 CFR Part 11 compliant system for a DoD lab" are not DOT
 * and HHS pursuits. In a transportation/health IT corpus these citations are
 * routine, and every one of them used to be re-filed under the standard's
 * owner. Applied to EVERY acronym, department-level and sub-agency alike.
 *
 * ── Why this is split into STRONG and WEAK ──────────────────────────────────
 * The words a solicitation uses to CITE a regulator are the same words a
 * federal agency puts in the title of its own contract: "FAA Certification
 * Services Support Contract", "DOT Rules Docket Management System", "VA
 * Compliance and Business Integrity Office", "HHS Requirements Analysis".
 * A guard that rejects on the bare noun alone deletes the buyer from the most
 * common title shape in this corpus — a false NEGATIVE, which makes the user's
 * own work invisible in the department filter they asked for.
 *
 * So only unambiguous citation SHAPES reject on sight (STRONG). The bare
 * regulatory nouns (WEAK) reject only when they are lowercase, i.e. running
 * prose — "OSHA and DOT regulations apply", "state DOE certification". A
 * Capitalised one is a proper-noun component of a program/office/system name
 * and the acronym in front of it is the buyer.
 */

/**
 * STRONG — citation shapes that can never be part of an agency's own title.
 *  · glued hyphen adjective: "FAA-compliant", "DOT-certified" (an agency never
 *    hyphenates its own name to "compliant"; note NO space is allowed, so the
 *    title separator in "DOT - Compliance Tracking System" is unaffected)
 *  · a regulation section or citation number: "FAA Part 107", "FDA 21 CFR 11"
 *  · a named clinical instrument: "NIH Stroke Scale"
 */
const REGULATORY_CITATION_STRONG_AFTER =
  /^(?:[-–—](?:compliant|compliance|certified|certification|accredited|approved|regulated|mandated|required|specified)\b|\s*(?:Part\s+\d|§|\d+\s+C\.?\s?F\.?\s?R\.?)|\s*(?:[A-Za-z][\w'-]*\s+){0,2}Scale\b)/i;

/**
 * WEAK — ordinary regulatory nouns. Only a citation when lowercase (see above).
 * Case-SENSITIVE by design: the leading letter is the whole discriminator.
 */
const REGULATORY_CITATION_WEAK_AFTER =
  /^\s*(?:[-–—]\s*)?(?:compliant|compliance|certified|certification|accredited|approved|regulations?|regs\b|rules?|standards?|guidelines?|requirements?|form\s+[A-Z0-9][\w-]*)\b/;

const REGULATORY_CITATION_BEFORE =
  /(?:\b\d+\s+C\.?\s?F\.?\s?R\.?(?:\s+(?:Part|§)\s*[\w.-]+)?|\bC\.?F\.?R\.?|\bU\.?S\.?C\.?|\b(?:per|under|pursuant\s+to|in\s+accordance\s+with|IAW|complies\s+with|compliant\s+with|conform(?:s|ing)?\s+to)\b)[\s,]*$/i;

function isRegulatoryCitation(ctx: AcronymContext): boolean {
  if (REGULATORY_CITATION_BEFORE.test(ctx.before)) return true;
  if (REGULATORY_CITATION_STRONG_AFTER.test(ctx.after)) return true;
  return REGULATORY_CITATION_WEAK_AFTER.test(ctx.after);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Mission vocabulary — the second way to corroborate a collision-prone acronym
 *
 * See MISSION VOCABULARY at the top of this file. Each of these is the subject
 * matter its bureau BUYS, never its org chart and never a generic IT verb. The
 * civilian homonym listed beside it is the thing that must keep returning null,
 * and is asserted in scripts/test-departments.mts §7d.
 *
 * All are non-global on purpose: they are `.test()`ed repeatedly and `g` would
 * make them stateful.
 * ──────────────────────────────────────────────────────────────────────────── */

/** FRA — Federal Railroad Administration vs "Financial Reporting Application". */
const MISSION_FRA =
  /\brail(?:road|way|car|s)?\b|\bgrade\s+crossing|\btrack\s+inspect|\bAmtrak\b|\blocomotive|\bpositive\s+train\s+control\b|\bhigh[-\s]speed\s+rail\b|\btrain\s+(?:safety|control|dispatch)/i;

/** FTA — Federal Transit Administration vs "Free Trade Agreement". */
const MISSION_FTA =
  /\btransit\b|\bparatransit\b|\bSection\s+53\d\d\b|\bNew\s+Starts\b|\bbus\s+rapid\b|\bcapital\s+investment\s+grant|\bNational\s+Transit\s+Database\b|\brolling\s+stock\b/i;

/** OST — Office of the Secretary of Transportation vs "Office of Strategy & Technology". */
const MISSION_OST = /\bSecretar(?:y|iat)\s+of\s+Transportation\b|\bOffice\s+of\s+the\s+Secretary\b/i;

/** NPS — National Park Service vs "Net Promoter Score". */
const MISSION_NPS =
  /\bnational\s+park|\bpark\s+(?:pass|ranger|unit|service|visitor)|\bcampground|\btrailhead|\bvisitor\s+cent(?:er|re)|\bnational\s+(?:seashore|lakeshore|battlefield|monument|historic|recreation\s+area)|(?<![A-Za-z0-9])recreation\.gov/i;

/** BIA — Bureau of Indian Affairs vs "Business Impact Analysis". */
const MISSION_BIA =
  /\bIndian\s+(?:Affairs|Country|reservation|education)\b|\btrib(?:e|es|al)\b|\bOffice\s+of\s+Justice\s+Services\b|\btrust\s+land|\bBureau\s+of\s+Indian\b|\bAlaska\s+Native\b/i;

/** OSM — Office of Surface Mining vs "OpenStreetMap". */
const MISSION_OSM = /\bsurface\s+mining\b|\babandoned\s+mine|\bmine\s+reclamation\b|\bcoal\s+reclamation\b/i;

/** BOR — Bureau of Reclamation vs "Board of Regents" / "bill of rights". */
const MISSION_BOR =
  /\breclamation\b|\bdam\s+safety\b|\birrigation\b|\bColorado\s+River\b|\bwater\s+(?:delivery|storage|conveyance)\b/i;

/** SNL — Sandia National Laboratories vs vendor initialisms. */
const MISSION_SNL = /\bSandia\b/i;

/** EIA — Energy Information Administration vs "Environmental Impact Assessment". */
const MISSION_EIA =
  /\bEnergy\s+Information\b|\bpetroleum\b|\bShort[-\s]Term\s+Energy\s+Outlook\b|\benergy\s+(?:data|statistics|outlook|survey)\b/i;

/** VCS — Veterans Canteen Service vs "version control system". */
const MISSION_VCS = /\bcanteen\b/i;

/**
 * CMS — Centers for Medicare & Medicaid Services vs Content/Contract Management
 * System, the single most dangerous acronym in this corpus. Every term here is
 * health-payer vocabulary that a CMS-the-webserver notice cannot plausibly use.
 */
const MISSION_CMS =
  /\bMedicare\b|\bMedicaid\b|\bCHIP\b|\bbeneficiar|\bHCPCS\b|\bICD-?(?:9|10|11)\b|\bprior\s+authorization\b|\bhealth\s+insurance\s+marketplace\b|\bMACRA\b|\bMIPS\b|\bfee[-\s]for[-\s]service\b|\bqualified\s+health\s+plan\b|\bclaims?\s+(?:adjudicat|processing\s+system)/i;

/** CDC — Centers for Disease Control vs "CDC Software", the ERP vendor. */
const MISSION_CDC =
  /\bepidemiolog|\boutbreak|\bsyndromic\b|\bimmuni[sz]ation\b|\bvaccin|\bpublic\s+health\b|\bdisease\s+(?:control|surveillance)\b|\bepidemic|\bmorbidity\b|\bcommunicable\s+disease\b/i;

/** IHS — Indian Health Service vs "IHS Markit". */
const MISSION_IHS =
  /\bIndian\s+Health\b|\btrib(?:e|es|al)\b|\bArea\s+Office\b|\bService\s+Unit\b|\bAlaska\s+Native\b|\bUrban\s+Indian\b/i;

/** ACF — Administration for Children and Families vs ordinary 3-letter noise. */
const MISSION_ACF =
  /\bchildren\s+and\s+families\b|\bchild\s+support\b|\bHead\s+Start\b|\bchild\s+care\b|\bfoster\s+care\b|\bchild\s+welfare\b|\bTANF\b|\brefugee\s+resettlement\b|\bunaccompanied\s+(?:alien\s+)?children\b/i;

/** ACL — Administration for Community Living vs "Access Control List". */
const MISSION_ACL =
  /\bcommunity\s+living\b|\bOlder\s+Americans\b|\baging\s+(?:network|services)\b|\bdisability\s+services\b|\blong[-\s]term\s+services\s+and\s+supports\b|\badult\s+protective\s+services\b/i;

/** NCI — National Cancer Institute vs vendor/product initialisms. */
const MISSION_NCI = /\bcancer\b|\boncolog|\btumou?r\s+registry\b/i;

/** IBC — Interior Business Center vs "International Building Code". */
const MISSION_IBC = /\bInterior\s+Business\s+Cent(?:er|re)\b|\bshared\s+services\s+cent(?:er|re)\b/i;

/* ────────────────────────────────────────────────────────────────────────────
 * FULL NAMES THAT ARE NOT SELF-SUFFICIENT
 *
 * Stage 1 (full names) outranks every acronym and every domain. That precedence
 * is the whole reason "…Department of the Interior … Herndon, VA…" is Interior
 * and not Veterans Affairs — and it is also why a WEAK entry in a full-name list
 * is far more damaging than a weak acronym: it beats an explicitly named
 * DIFFERENT agency, with no guard downstream to undo it.
 *
 * Two entries were weak in exactly that way, and both are guarded here rather
 * than deleted — deleting an entry throws its true positives away with its false
 * ones, and a false negative is the worst outcome this module has.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Bureau names that are ALSO an ordinary English phrase, so they only count when
 * written as a PROPER NOUN.
 *
 * phraseRegex() compiles case-INSENSITIVELY and has to: these cells are typed by
 * hand and arrive in every casing, including ALL CAPS ("INTERIOR, DEPARTMENT OF
 * · GEOLOGICAL SURVEY"). The cost was that ordinary lower-case prose matched
 * too, and "Contractor shall perform a geological survey of the pipeline
 * corridor" came back Department of the Interior — the same trap the DOI list
 * already avoids by refusing to enter bare "Interior" ("interior design",
 * "building interior"), applied to three entries that were added without it.
 *
 * The test is only that the match is not ENTIRELY lower-case, which is the
 * narrowest thing that separates the two readings: every genuine spelling still
 * lands ("Geological Survey", "U.S. Geological Survey", "GEOLOGICAL SURVEY"),
 * and only running prose is turned away.
 */
const PROPER_NOUN_ONLY_NAMES = new Set([
  // "perform a geological survey of the corridor" — a survey, not the USGS.
  "Geological Survey",
  // "building interior business center renovation" — construction scope text.
  "Interior Business Center",
  // "the national park service road repaving" — lower-case prose.
  "National Park Service",
]);

/**
 * Names that are a GENERIC ORGANISATIONAL TITLE: the owning department cannot be
 * read off the title at all, because every other agency has an office by the
 * same name. "Office of Information and Technology" belongs to GSA, the Justice
 * Department, NASA, Amtrak and Rutgers University as much as it does to the VA,
 * and as a bare full-name entry it filed every one of them under Veterans
 * Affairs — beating "General Services Administration" and "Department of
 * Justice" standing right next to it in the same string.
 *
 * Casing cannot separate these; every false positive above is properly
 * capitalised. So the entry instead asks for what a collision-prone ACRONYM
 * asks for: the parent department independently named in the same text, by full
 * name, department acronym or .gov domain (hasDepartmentCorroboration). "VA
 * Office of Information and Technology" and "Department of Veterans Affairs,
 * Office of Information and Technology" still match; the five agencies above do
 * not, and neither does a bare office title that names nobody — which is the
 * correct answer, because it really could be anyone's.
 */
const PARENT_REQUIRED_NAMES = new Set([
  "Office of Information and Technology",
]);

/* ────────────────────────────────────────────────────────────────────────────
 * The five priority departments
 *
 * ORDER IS PRECEDENCE. When two departments match at the same stage and the
 * same position, the one declared first wins.
 * ──────────────────────────────────────────────────────────────────────────── */

export const DEPARTMENTS: DepartmentDef[] = [
  {
    code: "DOT",
    label: "DOT — Transportation",
    name: "Department of Transportation",
    fullNames: [
      "Department of Transportation",
      "Transportation, Department of",
      // News/inverted styling: "the Transportation Department said…".
      "Transportation Department",
    ],
    subAgencyNames: [
      "Federal Aviation Administration",
      "Federal Motor Carrier Safety Administration",
      "National Highway Traffic Safety Administration",
      "Federal Highway Administration",
      "Federal Railroad Administration",
      "Federal Transit Administration",
      "Maritime Administration",
      "Pipeline and Hazardous Materials Safety Administration",
      "Volpe National Transportation Systems Center",
      "Volpe Center",
      "Office of the Secretary of Transportation",
      // The corporation was renamed in 2020; keep BOTH, old contract vehicles
      // and boilerplate still carry the retired name.
      "Great Lakes St. Lawrence Seaway Development Corporation",
      "Saint Lawrence Seaway Development Corporation",
    ],
    // The US-prefixed spellings carry their own proof: no state, county or city
    // abbreviates ITSELF "USDOT". They must therefore survive a jurisdiction
    // sitting earlier in the same cell — "Virginia Department of Transportation
    // coordinating with USDOT" names the federal department outright.
    acronyms: [
      { term: "DOT" },
      { term: "USDOT", provesFederal: true },
      { term: "US DOT", provesFederal: true },
      { term: "U.S. DOT", provesFederal: true },
    ],
    subAgencyAcronyms: [
      { term: "FAA" }, { term: "FMCSA" }, { term: "NHTSA" }, { term: "FHWA" },
      { term: "MARAD" }, { term: "PHMSA" },
      // FRA = Financial Reporting Application / Federal Railroad Administration.
      // FTA = Free Trade Agreement / Federal Transit Administration.
      // OST = Office of Strategy & Technology at half the primes in this market.
      { term: "FRA", needsCorroboration: true, corroboratedBy: MISSION_FRA },
      { term: "FTA", needsCorroboration: true, corroboratedBy: MISSION_FTA },
      { term: "OST", needsCorroboration: true, corroboratedBy: MISSION_OST },
    ],
    domains: ["dot.gov", "faa.gov", "nhtsa.gov", "transit.dot.gov", "fra.dot.gov", "volpe.dot.gov"],
  },
  {
    code: "DOI",
    label: "DOI — Interior",
    name: "Department of the Interior",
    // Bare "Interior" is deliberately NOT a full name: "interior design",
    // "interior painting" and "building interior" are all common in this corpus.
    fullNames: [
      "Department of the Interior", "Department of Interior",
      "Interior, Department of the", "Interior, Department of",
      "Interior Department",
    ],
    subAgencyNames: [
      // The next three are in PROPER_NOUN_ONLY_NAMES: each is also an ordinary
      // English phrase, and phraseRegex() is case-insensitive, so lower-case
      // prose ("a geological survey of the corridor", "building interior
      // business center renovation") matched them until that guard was added.
      "Interior Business Center",
      "Bureau of Land Management",
      "Bureau of Safety and Environmental Enforcement",
      "Bureau of Ocean Energy Management",
      "Bureau of Indian Affairs",
      "Bureau of Reclamation",
      "National Park Service",
      "Geological Survey",
      "Fish and Wildlife Service",
      "Office of Surface Mining",
      "Office of Surface Mining Reclamation and Enforcement",
    ],
    // "USDOI" is federal on its face — see the DOT note above.
    acronyms: [{ term: "DOI", accept: rejectDigitalObjectId }, { term: "USDOI", provesFederal: true }],
    subAgencyAcronyms: [
      { term: "BLM" }, { term: "BSEE" }, { term: "BOEM" }, { term: "USGS" },
      { term: "USFWS" }, { term: "OSMRE" }, { term: "USBR" }, { term: "FWS" },
      // NPS  = Net Promoter Score, the single most common survey metric in IT work.
      // BIA  = Business Impact Analysis (and Bureau of Industry and Analysis).
      // OSM  = OpenStreetMap, in every GIS solicitation this corpus contains.
      // BOR  = Board of Regents / bill of rights as often as Bureau of Reclamation.
      // IBC  = International Building Code, all over construction solicitations.
      { term: "NPS", needsCorroboration: true, corroboratedBy: MISSION_NPS },
      { term: "BIA", needsCorroboration: true, corroboratedBy: MISSION_BIA },
      { term: "OSM", needsCorroboration: true, corroboratedBy: MISSION_OSM },
      { term: "BOR", needsCorroboration: true, corroboratedBy: MISSION_BOR },
      { term: "IBC", needsCorroboration: true, corroboratedBy: MISSION_IBC },
    ],
    domains: ["doi.gov", "blm.gov", "nps.gov", "usgs.gov", "fws.gov", "bia.gov", "bsee.gov", "boem.gov", "usbr.gov", "osmre.gov"],
  },
  {
    code: "DOE",
    label: "DOE — Energy",
    name: "Department of Energy",
    fullNames: ["Department of Energy", "Energy, Department of", "Energy Department"],
    subAgencyNames: [
      "National Nuclear Security Administration",
      "Energy Efficiency and Renewable Energy",
      "Bonneville Power Administration",
      "Western Area Power Administration",
      "Energy Information Administration",
      // National laboratories. phraseRegex() folds Laboratory/Laboratories/Lab.
      "Oak Ridge National Laboratory",
      "Idaho National Laboratory",
      "Lawrence Livermore National Laboratory",
      "Lawrence Berkeley National Laboratory",
      "Pacific Northwest National Laboratory",
      "Los Alamos National Laboratory",
      "Sandia National Laboratories",
      "Argonne National Laboratory",
      "Brookhaven National Laboratory",
      "National Renewable Energy Laboratory",
      "Fermi National Accelerator Laboratory",
      "SLAC National Accelerator Laboratory",
      "Princeton Plasma Physics Laboratory",
      "National Energy Technology Laboratory",
      "Thomas Jefferson National Accelerator Facility",
      "Savannah River Site",
      "Savannah River National Laboratory",
    ],
    // Both spellings carry the SAME guard. "USDOE" used to carry none, so
    // "USDOE" and "DOE" disagreed on identical text.
    // "USDOE" is federal on its face — see the DOT note above. provesFederal is
    // checked AFTER accept(), so acceptDOE() still rules out the Education
    // reading ("USDOE school district curriculum portal" stays null).
    acronyms: [
      { term: "DOE", accept: acceptDOE },
      { term: "USDOE", accept: acceptDOE, provesFederal: true },
    ],
    // "BPA" is NOT here: in this app it means Blanket Purchase Agreement, and it
    // is already a contract-vehicle term in the targeting profile. "SRS" is not
    // here either — in a 541511 corpus it is a Software Requirements
    // Specification long before it is the Savannah River Site.
    subAgencyAcronyms: [
      { term: "NNSA" }, { term: "EERE" }, { term: "ARPA-E" },
      { term: "ORNL" }, { term: "PNNL" }, { term: "LLNL" }, { term: "INL" },
      { term: "LANL" }, { term: "NREL" }, { term: "ANL" }, { term: "BNL" },
      { term: "LBNL" }, { term: "FNAL" }, { term: "PPPL" }, { term: "NETL" },
      // SNL is also Sandia's own abbreviation but collides with vendor names.
      { term: "SNL", needsCorroboration: true, corroboratedBy: MISSION_SNL },
      // EIA = Energy Information Administration, but also "Environmental Impact
      // Assessment" — sheet row 64 is the corroborated form ("Department of
      // Energy EIA - IT Service Desk Support").
      { term: "EIA", needsCorroboration: true, corroboratedBy: MISSION_EIA },
    ],
    domains: ["energy.gov", "doe.gov", "nnsa.gov", "eia.gov", "ornl.gov", "pnnl.gov", "llnl.gov", "inl.gov", "lanl.gov", "nrel.gov", "anl.gov", "bnl.gov"],
  },
  {
    code: "VA",
    label: "VA — Veterans Affairs",
    name: "Department of Veterans Affairs",
    fullNames: [
      "Department of Veterans Affairs", "Veterans Affairs, Department of",
      "Veterans Affairs", "Veterans' Affairs", "Veterans Administration",
    ],
    subAgencyNames: [
      "Veterans Health Administration",
      "Veterans Benefits Administration",
      "National Cemetery Administration",
      "Veterans Integrated Service Network",
      "Veterans Canteen Service",
      // In PARENT_REQUIRED_NAMES — a generic office title that GSA, DOJ, NASA,
      // Amtrak and any university also use, so it only counts when VA itself is
      // named in the same text.
      "Office of Information and Technology",
    ],
    acronyms: [{ term: "VA", accept: acceptVA, provesFederal: true }],
    subAgencyAcronyms: [{ term: "VHA" }, { term: "VBA" }, { term: "VAMC" }, { term: "VISN" }, { term: "VCS", needsCorroboration: true, corroboratedBy: MISSION_VCS }],
    domains: ["va.gov"],
  },
  {
    code: "HHS",
    label: "HHS — Health and Human Services",
    name: "Department of Health and Human Services",
    // phraseRegex() folds "and" ↔ "&", so the ampersand spellings
    // ("Department of Health & Human Services") come for free.
    fullNames: [
      "Department of Health and Human Services", "Health and Human Services, Department of",
      "Health and Human Services",
    ],
    subAgencyNames: [
      "National Institutes of Health",
      "Centers for Disease Control",
      "Centers for Medicare and Medicaid Services",
      "Food and Drug Administration",
      "Health Resources and Services Administration",
      "Substance Abuse and Mental Health Services Administration",
      "Agency for Healthcare Research and Quality",
      "Indian Health Service",
      "National Center for Health Statistics",
      "Administration for Children and Families",
      "Administration for Community Living",
      "Administration for Strategic Preparedness and Response",
      "National Cancer Institute",
      "National Institute for Occupational Safety and Health",
      "Office of the Assistant Secretary for Planning and Evaluation",
      "Assistant Secretary for Financial Resources",
      "Assistant Secretary for Planning and Evaluation",
    ],
    acronyms: [{ term: "HHS" }, { term: "DHHS" }],
    subAgencyAcronyms: [
      { term: "NIH" }, { term: "FDA" }, { term: "HRSA" }, { term: "SAMHSA" },
      { term: "AHRQ" }, { term: "ASPR" }, { term: "NCHS" }, { term: "NIOSH" },
      { term: "ASPE" },
      // CMS = Content/Contract Management System — the single most dangerous
      // acronym in this corpus. CDC = CDC Software (ERP vendor). IHS = IHS
      // Markit. ACF/ACL/NCI are ordinary three-letter noise (Access Control
      // List, Adobe Camera Format…). All require the parent named nearby.
      { term: "CMS", needsCorroboration: true, corroboratedBy: MISSION_CMS },
      { term: "CDC", needsCorroboration: true, corroboratedBy: MISSION_CDC, civilianHomonym: /\bCDC\s+Software\b/i },
      { term: "IHS", needsCorroboration: true, corroboratedBy: MISSION_IHS, civilianHomonym: /\bIHS\s+Markit\b/i },
      { term: "ACF", needsCorroboration: true, corroboratedBy: MISSION_ACF },
      { term: "ACL", needsCorroboration: true, corroboratedBy: MISSION_ACL },
      { term: "NCI", needsCorroboration: true, corroboratedBy: MISSION_NCI },
    ],
    domains: ["hhs.gov", "nih.gov", "cdc.gov", "cms.gov", "fda.gov", "hrsa.gov", "samhsa.gov", "ahrq.gov", "ihs.gov", "acf.hhs.gov", "acl.gov", "cancer.gov"],
  },
];

/** Codes in priority order — safe for a filter dropdown. */
export const DEPARTMENT_CODES: DepartmentCode[] = DEPARTMENTS.map((d) => d.code);

/** code → dropdown label. */
export const DEPARTMENT_LABELS: Record<DepartmentCode, string> = DEPARTMENTS.reduce(
  (acc, d) => { acc[d.code] = d.label; return acc; },
  {} as Record<DepartmentCode, string>,
);

/** True for the five the user prioritized. Never a gate on what may be crawled. */
export function isPriorityDepartment(code: string | null | undefined): code is DepartmentCode {
  return !!code && (DEPARTMENT_CODES as string[]).includes(code);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Shared spelling fragments
 *
 * Defined here, ABOVE both of their consumers, because two very different
 * regexes need them and they must never drift apart.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Every accepted spelling of "Department" — the plural, the clipped forms, and
 * the common misspellings, which belong here because these rows are typed by
 * hand and "Department" is the most-typed word in the corpus. Every misspelling
 * listed is a non-word, so none of them can collide with ordinary prose.
 *
 * TWO CONSUMERS, AND THE GUARD IS THE REASON THEY SHARE A LIST.
 *   • TOKEN_VARIANTS folds these into every full name, so "Deptartment of
 *     Transportation" matches DOT.
 *   • JURISDICTION_PREFIX uses them to recognise "<State> Department of …".
 * If the jurisdiction guard knew FEWER spellings than the name matcher, "North
 * Carolina Deptartment of Health and Human Services" would block the long name
 * and then quietly match the short alias "Health and Human Services" three words
 * later — filing a state agency under the federal department. Adding a spelling
 * to one list and not the other silently reopens that hole.
 */
const DEPARTMENT_SPELLINGS = [
  "Departments", "Department", "Depts", "Dept", "Dep't",
  "Deptartment", "Departmant", "Deparment", "Departement", "Depatment",
  "Departmnet", "Dpeartment", "Depatrment",
];

/** Longest alternative first, so a prefix cannot satisfy a trailing boundary. */
const DEPARTMENT_WORD = `(?:${[...DEPARTMENT_SPELLINGS]
  .sort((a, b) => b.length - a.length)
  .map(escapeRegex)
  .join("|")})`;

/**
 * Separator following a CLIPPED abbreviation: either a period with optional
 * whitespace on both sides, or ordinary whitespace. One of the two is required,
 * so "Deptof Transportation" still — correctly — fails. Hand-typed cells
 * routinely drop the space after the period ("Dept.of Transportation") or add
 * one before it ("Dept . of Transportation").
 */
const ABBREVIATED_SEPARATOR = "(?:[\\s\\u00a0]*\\.[\\s\\u00a0]*|[\\s\\u00a0]+)";
const PLAIN_SEPARATOR = "[\\s\\u00a0]+";

/* ────────────────────────────────────────────────────────────────────────────
 * Address stripping
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Remove "<CITY>, XX 12345" / "XX 12345-6789" postal fragments.
 *
 * THE CITY MUST GO TOO, not just the code and the ZIP. Taking only "…, DC 20590"
 * off "Washington, DC 20590" leaves the bare word "Washington" — which is in
 * US_STATE_NAMES — sitting immediately in front of whatever the address block
 * was introducing, and the jurisdiction guard then vetoes the federal acronym
 * that follows. A federal POC block written city-first ("Washington, DC 20590 \n
 * DOT") returned null, which is the damaging direction: the row silently
 * disappears from the department filter.
 *
 * Washington/DC is only the most common instance of a general shape. Every one
 * of these leftovers trips a different clause of the same guard:
 *
 *     "Kansas City, MO 64106"      → "Kansas City"   (state name + \bcity\b)
 *     "Oklahoma City, OK 73102"    → "Oklahoma City" (state name + \bcity\b)
 *     "New York, NY 10001"         → "New York"      (state name, MAJOR_LOCAL_NAMES)
 *     "Jefferson City, MO 65101"   → "Jefferson City"(\bcity\b, MAJOR_LOCAL_NAMES)
 *
 * so the fix is written against the shape, not against a list of city names.
 *
 * A ZIP is still REQUIRED (except for the DC form below). Stripping a bare
 * ", XX" would also eat "Office of Information Technology, VA" — a legitimate
 * department reference — so that case is left to acceptVA(), the guard designed
 * for it.
 */
export function stripPostalAddresses(text: string): string {
  return text
    .replace(CITY_STATE_ZIP, (whole, anchor: string, city: string) =>
      // An ORGANISATION standing where the city should be is not an address.
      // "Federal Highway Administration, DC 20590" must keep its name and lose
      // only the code and the ZIP — which is exactly what STATE_ZIP below then
      // does to it, so declining here restores the pre-existing behaviour
      // rather than inventing a third one.
      NOT_A_CITY_NAME.test(city) ? whole : `${anchor} `,
    )
    .replace(DC_ADDRESS_WITH_ZIP, " ")
    .replace(DC_ADDRESS_LINE, " ")
    .replace(STATE_ZIP, " ");
}

/**
 * One word of a city name. Capitalised initial, and no digits — a street line
 * ("1200 New Jersey Ave SE") and a lower-cased connective ("Office of …") both
 * end the run, which is what keeps an organisation name out of the city slot.
 * The separator is a plain space, never a newline, so a city can only ever be
 * consumed together with the code and ZIP that sit on its own line.
 */
const CITY_TOKEN = "[A-Z][A-Za-z.'\\u2019-]*";
/** "Washington", "Kansas City", "Salt Lake City", "Winston-Salem", "St. Louis". */
const CITY_NAME = `${CITY_TOKEN}(?:[ \\u00a0]${CITY_TOKEN}){0,2}`;

/**
 * "<CITY>, XX 12345" — city included — anchored to a line start or to a comma.
 *
 * THE ANCHOR IS THE SAFETY RULE. A postal line is always written as its own line
 * or as the segment after a comma ("1200 New Jersey Ave SE, Washington, DC
 * 20590"), so requiring one of those two starts means the city slot can never
 * reach backwards into an organisation's name. "GSA Office of Information and
 * Technology, Reston, VA 20190" loses only "Reston, VA 20190"; and a line with
 * no city at all ("Contracting Office, VA 22060") matches nothing here and falls
 * through to STATE_ZIP below, exactly as it did before.
 *
 * The comma between city and code is optional because hand-typed cells drop it
 * ("Arlington VA 22202"), and the anchor is what makes that safe: only a line
 * consisting SOLELY of one-to-three capitalised words plus a code and a ZIP —
 * an address line by construction — can match.
 *
 * The capture group preserves the anchoring comma; the "m" flag is what lets
 * `^` mean "start of any line" without consuming the newline that separates the
 * address from the agency name above it.
 */
const CITY_STATE_ZIP = new RegExp(
  `(^|,)[ \\t\\u00a0]*(${CITY_NAME})[ \\u00a0]*,?[ \\u00a0]*\\b(?:${US_STATE_CODES})\\b` +
    `[ \\u00a0]+\\d{5}(?:-\\d{4})?\\b`,
  "gm",
);

/**
 * Words that mean the capitalised run in front of a postal code is an
 * ORGANISATION, not a city — the one way the anchored rule above can overreach.
 * "Federal Highway Administration, DC 20590" starts at a line start and is three
 * capitalised words followed by a code and a ZIP, so it fits the address shape
 * exactly; eating it would delete the very name that identifies the row.
 *
 * Case-insensitive on purpose: hand-typed cells arrive in ALL CAPS as often as
 * in title case ("FEDERAL ACQUISITION SERVICE").
 *
 * A few real towns are named after these words (Center TX, College Station WA,
 * Federal Way WA, National City CA). Rejecting them here is harmless: the match
 * simply falls through to STATE_ZIP, which is what used to handle every one of
 * these strings anyway.
 */
const NOT_A_CITY_NAME =
  /\b(?:departments?|dept|offices?|bureaus?|divisions?|agenc(?:y|ies)|authorit(?:y|ies)|commissions?|administrations?|boards?|councils?|secretariat|ministry|services?|cent(?:er|re)s?|headquarters|region|regional|federal|national|programs?|branch|section|group|solutions|systems|technolog(?:y|ies)|corp|corporation|compan(?:y|ies)|inc|llc|ltd|institute|laborator(?:y|ies)|universit(?:y|ies)|college|schools?|hospital|medical|affairs|contracting|procurement|purchasing|acquisitions?|command|facility|complex)\b/i;

/**
 * "Washington, D.C. 20590" in every spelling, anywhere in the text.
 *
 * DC gets its own rule because it is the seat of every federal department: it is
 * far and away the most likely address to appear in a federal POC block, it is
 * the one whose leftover city name is also a state name, and "D.C." with periods
 * is not a postal code so US_STATE_CODES never sees it.
 */
const DC_ADDRESS_WITH_ZIP =
  /\bWashington\s*,?\s*D\.?\s?C\.?\s*,?\s*\d{5}(?:-\d{4})?\b/g;

/**
 * "Washington, DC" with NO ZIP — but only where the address ENDS: at the end of
 * the text, at the end of its line, or against separating punctuation.
 *
 * The terminator is the whole guard. "Washington DC VA Medical Center" and
 * "Washington, DC Department of Transportation" are names, not addresses, and
 * both are left untouched: the first is a real VA facility, the second is how a
 * District of Columbia body would be written, and neither should lose its
 * leading words. A comma between the city and the code is required here for the
 * same reason.
 */
const DC_ADDRESS_LINE =
  /\bWashington[^\S\r\n]*,[^\S\r\n]*D\.?[^\S\r\n]?C\.?(?=[^\S\r\n]*(?:$|[\r\n,;:/|)\]]))/g;

/**
 * The original rule: a code and a ZIP with no recognisable city in front of them
 * ("Contracting Office, VA 22060", "…Region 3 Philadelphia PA 19107").
 */
const STATE_ZIP = new RegExp(`,?\\s*\\b(?:${US_STATE_CODES})\\b\\s+\\d{5}(?:-\\d{4})?\\b`, "g");

const US_STATE_NAMES =
  "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|" +
  "Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|" +
  "Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|" +
  "New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|" +
  "Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|" +
  "West Virginia|Wisconsin|Wyoming|Puerto Rico|District of Columbia|" +
  // Territories run their own DOT/DOE/DOI too ("Guam Department of Transportation").
  "Guam|Virgin Islands|American Samoa|Northern Mariana Islands";

/**
 * The same list without "Washington", for the ONE rule that walks past
 * intervening words (JURISDICTION_OWNED_ORG_NAME below).
 *
 * "Washington" is the only entry that is both a state and the seat of the
 * federal government, and stripPostalAddresses() leaves it behind: every federal
 * POC block in this corpus ends up containing a bare "Washington " once its
 * "DC 20590" is removed. A rule that may skip several words would then read
 * "Washington … Office of the Secretary … DOT" as a state agency and throw away
 * a genuinely federal row. The real Washington State agency writes itself
 * "Washington State Department of Transportation" (WSDOT), which is restored as
 * an explicit alternative — and the ADJACENT rule (JURISDICTION_NAME_SUFFIX)
 * still carries the full list, so "Washington DOT" is unaffected.
 */
const US_STATE_NAMES_EXCEPT_WASHINGTON = US_STATE_NAMES.split("|")
  .filter((n) => n !== "Washington")
  .join("|");

/**
 * Words that mark the thing in front of a department name as a LOCAL body even
 * though no state name appears: "Los Angeles County Health and Human Services
 * Agency", "Navajo Nation Department of Transportation", "Massachusetts Bay
 * Transportation Authority Department of Transportation".
 *
 * This is the POSTPOSITIVE form. The "<kind> of <name>" form ("City of Austin")
 * is handled separately below; between them they cover how local bodies
 * actually write their own names.
 */
const LOCAL_BODY_SUFFIX =
  "(?:Count(?:y|ies)|Parish|Boroughs?|Townships?|Municipalit(?:y|ies)|Nation|Tribe|Tribal\\s+Council|Pueblo|Rancheria|" +
  "School\\s+District|Public\\s+Schools|Unified\\s+School\\s+District|Authority|Councils?|Metro)";

/**
 * Bare place names that own a department without any "City of" wrapper:
 * "Chicago Department of Transportation", "Seattle Department of Transportation
 * (SDOT)", "Toronto Department of Transportation".
 *
 * DELIBERATELY REQUIRED TO SIT AT THE START OF A LINE. Several of these words
 * are also ordinary given names or surnames ("Austin", "Charlotte", "Jackson"),
 * and this corpus is full of POC name lines immediately above an agency name.
 * Anchoring to a line start keeps "Jane Austin\nDepartment of Transportation"
 * federal while still catching the real thing, which is always written as the
 * first token of its own line or cell.
 *
 * THE LIST IS THE LARGEST US CITIES PLUS EVERY STATE CAPITAL, because a state
 * capital is exactly where a city department gets written next to a federal one
 * ("Boise Department of Transportation" was read as the federal DOT). It is a
 * curated list and always will be — there are ~19,000 US municipalities and no
 * pattern distinguishes a city name from a surname. Names that are COMMON US
 * GIVEN NAMES OR SURNAMES are deliberately LEFT OUT even though they are real
 * capitals: Jackson, Madison, Salem, Dover, Augusta, Helena, Pierre, Franklin,
 * Montgomery, Lincoln, Concord, Springfield, Columbia, Trenton, Bismarck. In
 * this corpus a POC line above the agency line is far more likely than a
 * solicitation from Pierre, South Dakota, and a false NEGATIVE (the user's own
 * federal row vanishing from the filter) is the more expensive error.
 */
const MAJOR_LOCAL_NAMES =
  "New York City|NYC|Los Angeles|Chicago|Houston|Phoenix|Philadelphia|San Antonio|San Diego|" +
  "Dallas|Austin|San Jose|Jacksonville|Fort Worth|Columbus|Charlotte|Indianapolis|San Francisco|" +
  "Seattle|Denver|Boston|Nashville|Detroit|Portland|Baltimore|Milwaukee|Albuquerque|Tucson|" +
  "Fresno|Sacramento|Atlanta|Miami|Cleveland|Minneapolis|Saint Paul|St\\. Paul|Pittsburgh|" +
  "Cincinnati|Kansas City|Las Vegas|Oklahoma City|Memphis|Louisville|Tulsa|Omaha|Raleigh|" +
  "Richmond|Norfolk|Honolulu|Anchorage|Toronto|Vancouver|Montreal|Ottawa|London|Sydney|Melbourne|" +
  // Added: remaining large US cities and the unambiguous state capitals.
  "Boise|Anaheim|Arlington|Bakersfield|Baton Rouge|Buffalo|Chandler|Chattanooga|Chesapeake|" +
  "Chula Vista|Colorado Springs|Corpus Christi|Des Moines|Durham|El Paso|Fort Lauderdale|" +
  "Fort Wayne|Fremont|Garland|Gilbert|Glendale|Grand Rapids|Greensboro|Hialeah|Irvine|Irving|" +
  "Jersey City|Knoxville|Laredo|Lexington|Long Beach|Lubbock|Mesa|Modesto|New Orleans|Newark|" +
  "Newport News|North Las Vegas|Oakland|Orlando|Oxnard|Plano|Providence|Reno|Riverside|" +
  "Rochester|Saint Petersburg|St\\. Petersburg|Salt Lake City|San Bernardino|Santa Ana|" +
  "Santa Clarita|Scottsdale|Shreveport|Sioux Falls|Spokane|Stockton|Syracuse|Tacoma|" +
  "Tallahassee|Tampa|Tempe|Toledo|Topeka|Virginia Beach|Wichita|Winston-Salem|Worcester|" +
  "Yonkers|Annapolis|Harrisburg|Hartford|Frankfort|Lansing|Olympia|Cheyenne|Montpelier|" +
  "Juneau|Santa Fe|Carson City|Jefferson City|Albany|Little Rock";

/** "the ", quotes and brackets that may sit between a line start and the name. */
const LINE_START_LEAD = "(?:^|[\\r\\n])[\\s\"'(\\[]*(?:the\\s+)?";

/**
 * "City of Austin", "County of Orange", "Commonwealth of Virginia".
 *
 * The tribal kinds are here as well as in LOCAL_BODY_SUFFIX because a tribal
 * body is written BOTH ways — "Navajo Nation" (postpositive, caught by
 * LOCAL_BODY_SUFFIX) and "Tribal Nation of Oneida" (of-form, whose LAST token is
 * the place name, so the postpositive rule cannot see it).
 */
const JURISDICTION_OF_FORM =
  "\\b(?:city|county|town|township|borough|village|parish|commonwealth|state|district|municipality|" +
  "nation|tribe|pueblo|rancheria)\\s+of\\s+[A-Za-z .'-]{2,30}";

/**
 * Text that, immediately before a department's full name, means the name belongs
 * to a STATE or LOCAL body: "Virginia Department of Transportation" (VDOT),
 * "New York State Department of Transportation", "Maine Department of Health and
 * Human Services", "City of Austin Department of Transportation", "Los Angeles
 * County Health and Human Services Agency".
 *
 * Deliberately narrow on the federal side. "The U.S. Department of
 * Transportation" and "United States Department of Transportation" must NOT be
 * blocked — note the trailing \b on \bstate\b, which is what stops
 * "United States " from matching.
 *
 * PUNCTUATION IS TOLERATED between the jurisdiction and the name. "Commonwealth
 * of Virginia, Department of Transportation" and "State of Ohio — Department of
 * Transportation" are the normal way to write a state agency, and an anchor of
 * `\s*` alone let every one of them through as federal.
 *
 * The optional trailing "department of " matters more than it looks: VA and HHS
 * carry SHORT aliases ("Veterans Affairs", "Health and Human Services") that sit
 * INSIDE their own long form. Without it, "North Carolina Department of Health
 * and Human Services" blocks the long name and then quietly matches the short
 * one three words later.
 */
const JURISDICTION_SEPARATOR = "[\\s,;:./|()\\[\\]\\u2013\\u2014-]*";

const JURISDICTION_PREFIX = new RegExp(
  `(?:\\b(?:${US_STATE_NAMES})\\b` +
    `|${JURISDICTION_OF_FORM}` +
    `|\\b${LOCAL_BODY_SUFFIX}\\b` +
    `|${LINE_START_LEAD}(?:${MAJOR_LOCAL_NAMES})\\b` +
    `|\\bstate\\b|\\bmunicipal(?:ity)?\\b)` +
    `${JURISDICTION_SEPARATOR}(?:state${JURISDICTION_SEPARATOR})?` +
    `(?:${DEPARTMENT_WORD}${ABBREVIATED_SEPARATOR}of\\s+(?:the\\s+)?)?$`,
  "i",
);

/**
 * The same jurisdiction rule, applied to a BARE ACRONYM.
 *
 * JURISDICTION_PREFIX above can only fire on a string that spells the full name
 * out ("Minnesota Department of Transportation"). Most state and city rows never
 * do — they write "Virginia DOT", "NY DOT", "Mn/DOT", "Orange County DOT",
 * "City of Austin DOT", "Chicago DOE", "state DOE certification" — and every one
 * of those was being labelled FEDERAL. The problem is not DOT-specific: at state
 * level DOE is the Department of Education, DOI the Department of Insurance,
 * HHS the state health agency.
 *
 * Only DEPARTMENT-level acronyms are guarded (see the call site). Sub-agency
 * acronyms (FAA, NIH, BLM…) have no state analogue, so guarding them would only
 * invent false negatives for things like "FDA Minnesota District".
 *
 * A rejection here is not the last word: the acronym scan keeps walking (a later
 * "…and the U.S. DOT" still matches), and the .gov domain stage still runs, so a
 * genuinely federal row with a @dot.gov contact is recovered even if its only
 * acronym sat next to a city name.
 */
const JURISDICTION_NAME_SUFFIX = new RegExp(
  `(?:\\b(?:${US_STATE_NAMES})` +
    `|${JURISDICTION_OF_FORM}` +
    `|\\b${LOCAL_BODY_SUFFIX}` +
    `|\\b(?:county|parish|borough|township|municipality|city|state)` +
    `|${LINE_START_LEAD}(?:${MAJOR_LOCAL_NAMES}))$`,
  "i",
);

/**
 * Trailing two-letter postal abbreviation ("NY DOT", "PA DOT", "Mn/DOT").
 *
 * Deliberately requires a CAPITALISED token. Lower-case "in", "or", "me", "ok",
 * "la" and "co" are ordinary English words that are also postal codes, and
 * rejecting "improvements in DOT facilities" would be worse than the miss it
 * prevents.
 */
const TRAILING_POSTAL_CODE = /(?:^|[^A-Za-z0-9])([A-Z][A-Za-z])$/;

const POSTAL_CODE_SET = new Set(US_STATE_CODES.split("|"));

/** Punctuation/whitespace that can sit between a jurisdiction and its acronym. */
const ACRONYM_SEPARATOR = /[\s,./|()[\]:;–—-]+$/;

/**
 * Head nouns that make the words around them an AGENCY NAME rather than prose.
 *
 * "Service(s)" and "Center" are deliberately ABSENT. "Federal Acquisition
 * Service" and "Volpe National Transportation Systems Center" are federal, and
 * "FEDERAL ACQUISITION SERVICE" sits a few words from a city name in the POC
 * address block of the user's own rows 48, 50 and 58 — all three of which are
 * real federal rows resolved by a department acronym.
 */
const ORG_HEAD =
  `(?:${DEPARTMENT_WORD}|Offices?|Bureaus?|Divisions?|Agenc(?:y|ies)|Authorit(?:y|ies)|` +
  `Commissions?|Administrations?|Boards?|Councils?|Secretariat|Cabinet|Ministry)`;

/**
 * One word of an agency name. Anything containing a DIGIT or an "@" ends the
 * chain, which is what stops a street number, a phone number or an e-mail
 * address in a POC block from being read as part of the agency's name.
 */
const ORG_TOKEN = "[A-Za-z][A-Za-z&'\\u2019./-]*";

/**
 * A jurisdiction that owns the AGENCY NAME the acronym is attached to, with the
 * agency's own words in between:
 *
 *     "Virginia Department of Motor Vehicles - DOT records interface"
 *     "Maryland Transit Administration DOT grant application"
 *     "Nassau County\nDepartment of Public Works\nDOT coordination"
 *
 * This is the whole point of the rule. JURISDICTION_NAME_SUFFIX only sees the
 * token IMMEDIATELY before the acronym, so it catches "Virginia DOT" and misses
 * every one of the above — and the multi-line form, where the jurisdiction is on
 * one line and the acronym several lines later, is the shape the user's
 * hand-typed cells actually take.
 *
 * The token budget (4 words before the head noun, 5 after) is what keeps this
 * from becoming a whole-text scan: it has to look like one organisation's name,
 * not merely a state mentioned somewhere earlier in the cell.
 */
const JURISDICTION_OWNED_ORG_NAME = new RegExp(
  `(?:\\b(?:${US_STATE_NAMES_EXCEPT_WASHINGTON})\\b` +
    `|\\bWashington\\s+State\\b` +
    `|${JURISDICTION_OF_FORM}` +
    `|\\b${LOCAL_BODY_SUFFIX}\\b` +
    `|${LINE_START_LEAD}(?:${MAJOR_LOCAL_NAMES})\\b` +
    `|\\bstate\\b|\\bmunicipal(?:ity)?\\b)` +
    `${JURISDICTION_SEPARATOR}` +
    `(?:${ORG_TOKEN}[\\s\\u00a0]+){0,4}${ORG_HEAD}(?:[\\s\\u00a0]+${ORG_TOKEN}){0,5}$`,
  "i",
);

/**
 * Jurisdiction constructs specific enough to be believed ANYWHERE in the text
 * before the acronym, not merely adjacent to it or to its agency name:
 *
 *     "…\nCounty of Orange\n300 N Flower St\nDOT paving RFP"
 *     "The Commonwealth of Virginia through its … seeks DOT-related data"
 *
 * WHY THIS LIST IS SO MUCH NARROWER THAN THE ADJACENT ONE. A bare state or city
 * NAME must never be scanned across the whole cell. stripPostalAddresses() takes
 * the ZIP off "Washington, DC 20590" and leaves "Washington"; DC's streets are
 * named after states ("1200 New Jersey Ave SE" — US DOT's own headquarters); and
 * the user's real row 58 is a federal DOI row whose POC block reads "Boston, MA
 * 02222" 120 characters before the DOI acronym that identifies it. Scanning the
 * whole prefix for "Boston" or "New Jersey" would delete those rows from the
 * filter. "County of Orange" and "Nassau County" have no such second life.
 *
 * The leading negative lookahead is load-bearing: without it "the Nation's
 * transportation system" and "our nation" — ordinary federal boilerplate —
 * would read as a tribal nation.
 */
const STRONG_JURISDICTION_ANYWHERE = new RegExp(
  `\\b(?:city|county|town|township|borough|village|parish|municipality)\\s+of\\s+[A-Za-z]` +
    `|\\b(?:state|commonwealth|territory)\\s+of\\s+(?:${US_STATE_NAMES})\\b` +
    `|\\b(?:nation|tribe|pueblo|rancheria)\\s+of\\s+[A-Za-z]{3}` +
    `|\\b(?!the\\b|a\\b|an\\b|our\\b|this\\b|these\\b|that\\b|each\\b|any\\b|every\\b|entire\\b|whole\\b|great\\b|one\\b)` +
    `[A-Za-z][A-Za-z'\\u2019.-]+\\s+(?:count(?:y|ies)|parish|boroughs?|townships?|municipalit(?:y|ies)|` +
    `tribe|nation|pueblo|rancheria|school\\s+district|public\\s+schools)\\b`,
  "i",
);

/**
 * True when the text before an acronym shows the acronym belongs to a state,
 * territory, county, tribal nation or city body rather than the federal
 * department. `before` must be EVERYTHING preceding the hit, not a window —
 * the line-start rules in JURISDICTION_NAME_SUFFIX need a real start-of-string.
 *
 * THREE TESTS, WIDEST SCOPE FIRST:
 *   1. STRONG_JURISDICTION_ANYWHERE — an unmistakable local body named anywhere
 *      in the preceding text ("County of Orange", "Nassau County").
 *   2. JURISDICTION_OWNED_ORG_NAME — a jurisdiction plus the agency name it owns,
 *      running right up to the acronym ("Maryland Transit Administration DOT").
 *   3. JURISDICTION_NAME_SUFFIX / TRAILING_POSTAL_CODE — the jurisdiction sitting
 *      directly against the acronym ("Virginia DOT", "Mn/DOT").
 *
 * A rejection here is still not the last word: the acronym scan keeps walking to
 * a later occurrence, and the .gov domain stage runs afterwards regardless.
 */
export function isJurisdictionOwnedAcronym(before: string): boolean {
  // (1) Whole-prefix evidence. Deliberately runs before the adjacency tests —
  //     it is a property of the text, not of what abuts the acronym.
  if (STRONG_JURISDICTION_ANYWHERE.test(before)) return true;

  const head = before.replace(ACRONYM_SEPARATOR, "");
  // Require that a real separator was consumed. Anything else means the text
  // butts straight against the acronym, which the word-bounded acronym scan
  // would never have matched in the first place.
  if (head === before) return false;
  // "state DOE certification": the whole prefix WAS the jurisdiction.
  if (head === "") return /\bstate\b|\bcity\b|\bcounty\b/i.test(before);
  // (2) Jurisdiction + the agency name it owns.
  if (JURISDICTION_OWNED_ORG_NAME.test(head)) return true;
  // (3) Jurisdiction directly against the acronym.
  if (JURISDICTION_NAME_SUFFIX.test(head)) return true;
  const m = TRAILING_POSTAL_CODE.exec(head);
  return !!m && POSTAL_CODE_SET.has(m[1].toUpperCase());
}

/* ────────────────────────────────────────────────────────────────────────────
 * Matching primitives
 * ──────────────────────────────────────────────────────────────────────────── */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Spelling variants folded into EVERY full name, once, here — instead of being
 * pasted into each department's list by hand.
 *
 *   Department      → Dept. / Dept / Dep't      ("U.S. Dept. of Transportation")
 *   Administration  → Admin. / Admin            ("Federal Aviation Admin.")
 *   Federal         → Fed.                      ("Fed. Aviation Administration")
 *   National        → Natl / Nat'l / Nat.       ("Oak Ridge Natl Laboratory")
 *   Health          → Hlth                      ("Veterans Hlth Administration")
 *   Management      → Mgmt / Mgt                ("Bureau of Land Mgmt")
 *   Center(s)       → Ctrs / Ctr                ("Ctrs for Disease Control")
 *   and             → & / &amp;                 ("Health &amp; Human Services")
 *   Laborator(y|ies)→ Lab. / Labs               ("Oak Ridge National Lab")
 *   Saint           → St.                       ("St. Lawrence Seaway")
 *
 * The user types these rows in by hand, so the abbreviated spellings are the
 * norm, not the exception. Nothing here can fire on its own: a variant only ever
 * matches as one token of a COMPLETE multi-word name from the lists above, so
 * "Fed" cannot match the Federal Reserve and "Nat" cannot match a given name —
 * "Fed" is only ever tried against "Fed<sep>Aviation<sep>Administration".
 *
 * `abbrev: true` marks a group that has a CLIPPED form. A clipped form may be
 * followed by a period, and the whitespace around that period is optional, so
 * "Dept. of", "Dept of", "Dept.of" and "Dept . of" are one entry, not four. That
 * spacing matters: hand-typed cells routinely drop the space after the period.
 *
 * "department" additionally carries its common MISSPELLINGS. It is the
 * most-typed word in this corpus, and three of the five departments (DOT, DOI,
 * DOE) have no short alias to fall back on, so one slipped letter used to drop
 * the row out of the filter entirely. They are listed HERE, at the full-name
 * stage, rather than left to the typo-tolerant stage further down, so that
 * FULL NAMES WIN survives a typo: a misspelt department name must still outrank
 * a stray acronym elsewhere in the same cell.
 *
 * "&amp;" is here because these cells are pasted straight out of procurement
 * portals, which serve HTML — the entity arrives undecoded in the paste buffer.
 */
interface VariantGroup {
  /** Lower-cased tokens, as written in the department lists, that select this group. */
  keys: string[];
  /** Interchangeable spellings; sorted longest-first when the regex is built. */
  alts: string[];
  /** The group has a clipped form, so a period may follow it — see above. */
  abbrev?: boolean;
}

const VARIANT_GROUPS: VariantGroup[] = [
  // Shared with JURISDICTION_PREFIX — see DEPARTMENT_SPELLINGS for why.
  { keys: ["department", "departments"], alts: DEPARTMENT_SPELLINGS, abbrev: true },
  { keys: ["administration", "administrations"], alts: ["Administrations", "Administration", "Adminstration", "Administraton", "Admins", "Admin"], abbrev: true },
  { keys: ["administrator", "administrators"], alts: ["Administrators", "Administrator", "Admins", "Admin"], abbrev: true },
  { keys: ["and"], alts: ["and", "&amp;", "&#38;", "&"] },
  { keys: ["laboratory", "laboratories"], alts: ["Laboratories", "Laboratory", "Labs", "Lab"], abbrev: true },
  { keys: ["corporation", "corporations"], alts: ["Corporations", "Corporation", "Corps", "Corp"], abbrev: true },
  { keys: ["saint", "st"], alts: ["Saint", "St"], abbrev: true },
  { keys: ["service", "services"], alts: ["Services", "Service", "Svcs", "Svc"], abbrev: true },
  { keys: ["institute", "institutes"], alts: ["Institutes", "Institute", "Insts", "Inst"], abbrev: true },
  { keys: ["center", "centers", "centre", "centres"], alts: ["Centers", "Centres", "Center", "Centre", "Ctrs", "Ctr"], abbrev: true },
  { keys: ["federal"], alts: ["Federal", "Fed"], abbrev: true },
  { keys: ["national"], alts: ["National", "Nat'l", "Natl", "Nat"], abbrev: true },
  { keys: ["health"], alts: ["Health", "Hlth"], abbrev: true },
  { keys: ["management"], alts: ["Management", "Mgmt", "Mgt"], abbrev: true },
  { keys: ["bureau", "bureaus"], alts: ["Bureaus", "Bureau", "Bur"], abbrev: true },
  { keys: ["office", "offices"], alts: ["Offices", "Office", "Ofc"], abbrev: true },
  { keys: ["information"], alts: ["Information", "Info"], abbrev: true },
  { keys: ["technology", "technologies"], alts: ["Technologies", "Technology", "Tech"], abbrev: true },
  { keys: ["development"], alts: ["Development", "Devt", "Dev"], abbrev: true },
  { keys: ["highway", "highways"], alts: ["Highways", "Highway", "Hwy"], abbrev: true },
  { keys: ["systems", "system"], alts: ["Systems", "System", "Sys"], abbrev: true },
  { keys: ["veterans"], alts: ["Veterans'", "Veteran's", "Veterans", "Vets"], abbrev: true },
  { keys: ["agency", "agencies"], alts: ["Agencies", "Agency"] },
  { keys: ["survey", "surveys"], alts: ["Surveys", "Survey"] },
];

interface TokenVariant {
  /** Every accepted spelling, lower-cased — used by the typo-tolerant stage. */
  forms: string[];
  /** Alternation body for phraseRegex(). */
  body: string;
  abbrev: boolean;
}

const TOKEN_VARIANTS: Record<string, TokenVariant> = (() => {
  const map: Record<string, TokenVariant> = {};
  for (const group of VARIANT_GROUPS) {
    // Longest alternative first, so a phrase's tail boundary check cannot be
    // satisfied by a prefix ("Dept" swallowing the head of "Department").
    const alts = [...group.alts].sort((a, b) => b.length - a.length);
    const variant: TokenVariant = {
      forms: alts.map((a) => a.toLowerCase()),
      body: `(?:${alts.map(escapeRegex).join("|")})`,
      abbrev: !!group.abbrev,
    };
    for (const key of group.keys) map[key] = variant;
  }
  return map;
})();

/**
 * Word-bounded regex for a multi-word NAME, tolerant of the abbreviations in
 * TOKEN_VARIANTS and of any run of whitespace (these cells are multi-line).
 * `g` so callers can walk every occurrence.
 */
function phraseRegex(phrase: string): RegExp {
  const tokens = phrase.split(/\s+/);
  const body = tokens
    .map((token, i) => {
      const bare = token.replace(/[^A-Za-z0-9']+$/, "");
      let trail = token.slice(bare.length);
      const variant = TOKEN_VARIANTS[bare.toLowerCase()];
      // A period written into the LIST itself ("St. Lawrence Seaway") is the
      // abbreviation's own period. ABBREVIATED_SEPARATOR already makes it
      // optional, so drop it here rather than DEMANDING it and thereby
      // rejecting the equally common "St Lawrence Seaway".
      if (variant?.abbrev && trail === ".") trail = "";
      const head = (variant?.body ?? escapeRegex(bare)) + escapeRegex(trail);
      if (i === tokens.length - 1) return head + (variant?.abbrev ? "\\.?" : "");
      return head + (variant?.abbrev ? ABBREVIATED_SEPARATOR : PLAIN_SEPARATOR);
    })
    .join("");
  const lead = /^[A-Za-z0-9]/.test(phrase) ? "(?<![A-Za-z0-9])" : "";
  const tail = /[A-Za-z0-9]$/.test(phrase) ? "(?![A-Za-z0-9])" : "";
  return new RegExp(`${lead}${body}${tail}`, "gi");
}

/**
 * A plain all-caps initialism, which is the only shape that has a meaningful
 * period-separated spelling. Terms that already carry punctuation or a space
 * ("ARPA-E", "U.S. DOT", "US DOT") are left exactly as written.
 */
const PLAIN_INITIALISM = /^[A-Z]{2,}$/;

/**
 * Word-bounded regex for a literal ACRONYM, using lookarounds rather than \b so
 * that symbol-bearing terms ("ARPA-E", "U.S. DOT") behave. Always case-
 * sensitive: that is what keeps "doi.gov" and "template.dot" from firing.
 *
 * THE PERIOD-SEPARATED SPELLING IS DERIVED HERE, ONCE, for every list — the same
 * bargain phraseRegex() makes for "Dept."/"&". A hand-typed cell says "D.O.T.",
 * "H.H.S." or "U.S.D.O.T." about as readily as "DOT", and every one of those was
 * matching nothing at all because the lists only ever carried the contiguous
 * spelling. Writing them out by hand would mean eight new literals on the
 * department lists alone and a fresh gap every time a sub-agency is added.
 *
 * The derived form puts a period between EVERY letter and makes only the
 * trailing one optional ("D.O.T." and "D.O.T", never "D.OT"). That is how people
 * actually write an initialism, and the strictness is deliberate: a looser
 * "period allowed anywhere" pattern would let a term match across abbreviation
 * boundaries it has no business crossing.
 */
function acronymRegex(term: string): RegExp {
  // Dotted form first: at a given position it is the longer match, and for a
  // contiguous spelling it simply fails and falls through to the literal.
  const alternatives = PLAIN_INITIALISM.test(term)
    ? [`${term.split("").join("\\.")}\\.?`, escapeRegex(term)]
    : [escapeRegex(term)];
  const lead = /^[A-Za-z0-9]/.test(term) ? "(?<![A-Za-z0-9])" : "";
  const tail = /[A-Za-z0-9]$/.test(term) ? "(?![A-Za-z0-9])" : "";
  return new RegExp(`${lead}(?:${alternatives.join("|")})${tail}`, "g");
}

const WINDOW = 80;

/**
 * A term glued to a preceding token by a period — "template.DOT", "report.DOE",
 * "archive.doi" — is a filename or a domain label, not an agency.
 */
const FILENAME_STEM_BEFORE = /[A-Za-z0-9]\.$/;

/**
 * …EXCEPT when that preceding token is itself a period-separated initialism:
 * "U.S.DOT", "U.S.DOE", "U.S.DOI". Every token in the run is a SINGLE letter
 * followed by a period, which is exactly what a filename stem is not — a stem
 * ends in a whole word ("template.", "report."). Without this carve-out the
 * filename guard throws away the "U.S." prefix that the file's own header
 * advertises as a supported spelling.
 *
 * Bounded to four groups so it stays a US/U.K.-style prefix rather than an
 * open-ended scan back through the cell.
 */
const DOTTED_INITIALISM_BEFORE = /(?:^|[^A-Za-z0-9])(?:[A-Za-z]\.){1,4}$/;

/** First acceptable occurrence of an acronym, or -1. */
function findAcronym(
  text: string,
  term: string,
  accept?: (ctx: AcronymContext) => boolean,
): number {
  const re = acronymRegex(term);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const idx = m.index;
    const beforeAll = text.slice(0, idx);
    const before = text.slice(Math.max(0, idx - WINDOW), idx);
    const after = text.slice(idx + m[0].length, idx + m[0].length + WINDOW);
    // Guard shared by every acronym: "TEMPLATE.DOT", "report.doe" — a term glued
    // to a preceding token by a dot is a filename or a domain label, not an
    // agency. A dotted initialism ("U.S.DOT") is the one thing that looks like
    // this and is not a filename.
    if (FILENAME_STEM_BEFORE.test(before) && !DOTTED_INITIALISM_BEFORE.test(before)) continue;
    const ctx: AcronymContext = {
      before, after, beforeAll, full: text,
      start: idx, end: idx + m[0].length,
    };
    // The acronym is being cited as a standard, not named as a buyer.
    if (isRegulatoryCitation(ctx)) continue;
    if (accept && !accept(ctx)) continue;
    // Zero-width safety: exec on a `g` regex always advances for non-empty matches.
    return idx;
  }
  return -1;
}

/**
 * First occurrence of a full department/bureau name that is NOT state/local.
 *
 * `blockedSpans` are the [start, end) offsets of the occurrences that WERE
 * present but owned by a state or city. The caller uses them to reject the state
 * body's OWN abbreviation — the "(Mn/DOT)" in "Minnesota Department of
 * Transportation (Mn/DOT)" — without suppressing the acronym stage wholesale.
 * SPANS, not a boolean: see isStateNameRestatement() for why that difference is
 * load-bearing.
 *
 * The jurisdiction test sees the WHOLE preceding text, not a window, because
 * JURISDICTION_PREFIX contains start-of-line anchors.
 *
 * A PROPER_NOUN_ONLY_NAMES entry additionally has to be spelled as a name rather
 * than as the ordinary English phrase it shares — see that set for why. A
 * rejection there is NOT blocking: blocking means "this department owns the name
 * but a state owns this department", which is the one thing that can suppress an
 * acronym. Prose that merely reads like a bureau name proves nothing about any
 * department and must leave the later stages free to run.
 */
function scanFullName(
  text: string,
  phrase: string,
): { index: number; blockedSpans: Array<[number, number]> } {
  const re = phraseRegex(phrase);
  const properNounOnly = PROPER_NOUN_ONLY_NAMES.has(phrase);
  let m: RegExpExecArray | null;
  const blockedSpans: Array<[number, number]> = [];
  while ((m = re.exec(text)) !== null) {
    if (properNounOnly && !hasUpperCase(m[0])) continue;
    if (JURISDICTION_PREFIX.test(text.slice(0, m.index))) {
      blockedSpans.push([m.index, m.index + m[0].length]);
      continue;
    }
    return { index: m.index, blockedSpans: [] };
  }
  return { index: -1, blockedSpans };
}

/**
 * The gap between a name and its own abbreviation: punctuation, quotes, brackets
 * and the handful of filler words that introduce one ("or", "aka", "hereinafter
 * the"). Anything else — a real word — means the acronym is a SEPARATE mention,
 * not a restatement of the name beside it.
 *
 * Bounded repetition, and only ever applied to a short slice, so it cannot
 * backtrack pathologically on a long hand-typed cell.
 */
const ABBREVIATION_PUNCT = "[\\s\"'\\u2018\\u2019\\u201c\\u201d(){}\\[\\]<>,;:.\\u2013\\u2014/|-]*";
const ABBREVIATION_GAP = new RegExp(
  `^${ABBREVIATION_PUNCT}` +
    `(?:(?:also\\s+)?(?:known\\s+as|referred\\s+to\\s+as|abbreviated(?:\\s+as)?|` +
    `hereinafter(?:\\s+(?:the|called))?|a\\.k\\.a\\.?|aka|or|the|its)${ABBREVIATION_PUNCT}){0,3}$`,
  "i",
);

/** Longest gap that can still be an abbreviation of the name beside it. */
const ABBREVIATION_GAP_MAX = 48;

/**
 * True when an acronym hit at [start, end) is the STATE body's own abbreviation
 * — it restates a jurisdiction-owned full name sitting immediately beside it:
 * "Minnesota Department of Transportation (Mn/DOT)", "Texas Health and Human
 * Services, HHS", "Virginia Department of Transportation or DOT".
 *
 * WHY THIS IS SCOPED TO THE OCCURRENCE AND NOT TO THE DEPARTMENT. The previous
 * version was a plain per-department flag: ONE jurisdiction-owned full name
 * anywhere in the cell suppressed that department for the WHOLE acronym, domain
 * and fuzzy stages. That is a false-negative machine on one of the commonest
 * shapes there is — a state body naming its federal partner:
 *
 *     "Virginia Department of Transportation coordinating with USDOT"  → null
 *     "Texas Health and Human Services Commission under an HHS grant"  → null
 *
 * Both spell the federal department out, unambiguously ("USDOT" is not a thing
 * any state owns), and both vanished from the filter the user asked for. The
 * flag also contradicted the rule the rest of this module is built on and states
 * outright: the jurisdiction test is an ADJACENCY rule, not a "some state word
 * appears somewhere in the cell" rule — the same distinction pinned by the
 * departmentForOpportunity() pair in scripts/test-departments.mts, where an
 * adjacent "Virginia" vetoes a following DOT and a distant one does not.
 *
 * The restatement can sit on EITHER side of the name — "…Transportation (DOT)"
 * and "DOT (Virginia Department of Transportation)" are the same construction in
 * the two orders — so both directions are checked. An acronym that OVERLAPS the
 * blocked name is inside it and is rejected outright.
 */
function isStateNameRestatement(
  text: string,
  start: number,
  end: number,
  blockedSpans: ReadonlyArray<readonly [number, number]>,
): boolean {
  for (const [nameStart, nameEnd] of blockedSpans) {
    if (nameEnd <= start) {
      if (start - nameEnd <= ABBREVIATION_GAP_MAX && ABBREVIATION_GAP.test(text.slice(nameEnd, start))) return true;
      continue;
    }
    if (nameStart < end) return true; // the acronym sits INSIDE the state body's name
    if (nameStart - end > ABBREVIATION_GAP_MAX) continue;
    const gap = text.slice(end, nameStart);
    if (ABBREVIATION_GAP.test(gap)) return true;
    // Expansion-after-abbreviation: "DOT (Virginia Department of
    // Transportation)". The blocked span covers the DEPARTMENT NAME only, so the
    // jurisdiction that blocked it is still sitting in the gap. Peel it off with
    // the very regex that did the blocking and re-test what is left — which is
    // what keeps "U.S. DOT and the Virginia Department of Transportation"
    // federal, since " and the " is a real clause, not an abbreviation gap.
    const j = JURISDICTION_PREFIX.exec(gap);
    if (j && ABBREVIATION_GAP.test(gap.slice(0, j.index))) return true;
  }
  return false;
}

/**
 * Is any letter in the matched span upper-case? The test for
 * PROPER_NOUN_ONLY_NAMES, and deliberately the weakest form of it: "Geological
 * Survey", "U.S. Geological Survey" and "GEOLOGICAL SURVEY" all pass, and only
 * an entirely lower-case run — running prose — fails.
 */
function hasUpperCase(s: string): boolean {
  return /[A-Z]/.test(s);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Typo tolerance — the LAST stage, and deliberately the weakest
 *
 * TOKEN_VARIANTS covers the misspellings of "Department" because that word is
 * typed on nearly every row. It cannot cover the department's OWN name: there is
 * no finite list of ways to fat-finger "Transportation", and "Department of
 * Transportaton" is a row that vanishes from the exact filter the user asked for.
 *
 * So: line a full name up against the text as a TOKEN STREAM and allow AT MOST
 * ONE token to be off by a single typo. The fuzzed token must be at
 * least FUZZY_MIN_LENGTH long and must start with the same letter, which is what
 * keeps the structural words ("of", "the", "and") exact and keeps sibling
 * departments apart — "Department of Education" cannot become "…of Energy"
 * (e/e, but 3 edits apart) and "Department of the Treasury" cannot become
 * "…the Interior" (t vs i).
 *
 * THREE PROPERTIES MAKE THIS SAFE TO ADD:
 *   1. It runs only when stages 1-3 found NOTHING, so it can never change an
 *      answer the exact matcher already gave. It can only rescue a null.
 *   2. It requires at least one real edit. An exactly-matching token run is
 *      handed back to stage 1, so this stage never becomes a
 *      punctuation-insensitive matcher that could staple two sentences together
 *      ("…of Energy. Department of Commerce" → DOE).
 *   3. JURISDICTION_PREFIX still applies, so a typo'd "Virginia Deptartment of
 *      Transportation" stays out of the federal filter.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Shortest name token that may be fuzzed. Below this, one edit is a different word. */
const FUZZY_MIN_LENGTH = 6;

/** Words, ampersands and HTML ampersand entities, with their offsets. */
const TEXT_TOKEN = /&amp;|&#38;|&|[A-Za-z][A-Za-z']*|\d+/g;

interface TextToken {
  /** Lower-cased. */
  text: string;
  index: number;
}

function tokenizeForFuzzy(text: string): TextToken[] {
  const re = new RegExp(TEXT_TOKEN.source, "g");
  const out: TextToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ text: m[0].toLowerCase(), index: m.index });
  return out;
}

interface PhraseToken {
  /** Lower-cased canonical spelling, as written in the department list. */
  canonical: string;
  /** Canonical plus every TOKEN_VARIANTS spelling, lower-cased. */
  forms: Set<string>;
}

const PHRASE_TOKEN_CACHE = new Map<string, PhraseToken[]>();

function phraseTokens(phrase: string): PhraseToken[] {
  const cached = PHRASE_TOKEN_CACHE.get(phrase);
  if (cached) return cached;
  const tokens = phrase.split(/\s+/).map((raw) => {
    const canonical = raw.replace(/[^A-Za-z0-9']+$/, "").toLowerCase();
    const forms = new Set<string>([canonical]);
    for (const form of TOKEN_VARIANTS[canonical]?.forms ?? []) forms.add(form);
    return { canonical, forms };
  });
  PHRASE_TOKEN_CACHE.set(phrase, tokens);
  return tokens;
}

/**
 * One typo apart: a single insertion, deletion or substitution, OR a single
 * transposition of two adjacent characters.
 *
 * The transposition arm is not a nicety — it is the commonest typing error there
 * is, and plain Levenshtein scores it as TWO edits, so without it "Enegry" and
 * "Transportatoin" are rejected while the far less likely "Enegy" is accepted.
 *
 * Implemented by trimming the common prefix and suffix, which leaves at most a
 * two-character disagreement to classify — no matrix needed.
 */
function withinOneTypo(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  let head = 0;
  while (head < la && head < lb && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < la - head && tail < lb - head && a[la - 1 - tail] === b[lb - 1 - tail]) tail++;

  const restA = la - head - tail;
  const restB = lb - head - tail;
  // (1,1) substitution, (0,1) insertion, (1,0) deletion.
  if (restA <= 1 && restB <= 1) return true;
  // (2,2) with the pair swapped: "enegry" ↔ "energy".
  return restA === 2 && restB === 2 && a[head] === b[head + 1] && a[head + 1] === b[head];
}

/**
 * First offset at which `phrase` appears in the token stream with exactly one
 * token misspelt, and no state/local jurisdiction owning it. -1 when absent.
 */
function scanFuzzyName(text: string, tokens: TextToken[], phrase: string): number {
  const want = phraseTokens(phrase);
  // A one-token name would be a one-token guess. There are none in the lists,
  // and there must never be one.
  if (want.length < 2) return -1;
  outer: for (let start = 0; start + want.length <= tokens.length; start++) {
    let fuzzed = false;
    for (let k = 0; k < want.length; k++) {
      const got = tokens[start + k].text;
      const expected = want[k];
      if (expected.forms.has(got)) continue;
      if (
        !fuzzed &&
        expected.canonical.length >= FUZZY_MIN_LENGTH &&
        got.length >= FUZZY_MIN_LENGTH - 1 &&
        got[0] === expected.canonical[0] &&
        withinOneTypo(got, expected.canonical)
      ) {
        fuzzed = true;
        continue;
      }
      continue outer;
    }
    // Matched with no edits at all: stage 1 has already had its say on this, and
    // rescuing it here would silently widen the separator rules. See (2) above.
    if (!fuzzed) continue;
    if (JURISDICTION_PREFIX.test(text.slice(0, tokens[start].index))) continue;
    // Same proper-noun rule stage 1 applies. The token stream is lower-cased, so
    // the ORIGINAL span has to be re-read: without this, "perform a geologicel
    // survey" walks in through the door stage 1 just closed.
    if (PROPER_NOUN_ONLY_NAMES.has(phrase)) {
      const last = tokens[start + want.length - 1];
      if (!hasUpperCase(text.slice(tokens[start].index, last.index + last.text.length))) continue;
    }
    return tokens[start].index;
  }
  return -1;
}

/**
 * A .gov domain inside an email or URL.
 *
 * The lookbehind rejects a domain glued to a preceding word — "danvilleva.gov"
 * is the City of Danville, not va.gov — while still allowing a leading dot so
 * real subdomains ("ibc.doi.gov", "www.va.gov") match.
 */
function domainRegex(domain: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${domain.replace(/\./g, "\\.")}(?![A-Za-z0-9])`, "i");
}

/**
 * Does the text independently name this department, so that a collision-prone
 * sub-agency acronym in it can be trusted? Satisfied by the department's own
 * full name, its own acronym, or one of its .gov domains (the domain list
 * includes the bureaus' own domains — cms.gov, nps.gov, cdc.gov — so an
 * "@cms.gov" contact corroborates CMS on its own).
 *
 * This is the PARENT-NAMED half of corroboration. It is not sufficient by
 * itself: most federal notices name only the operating division, because inside
 * the government the parent is implicit. The other half is the acronym's own
 * mission vocabulary — see isCorroborated() and MISSION VOCABULARY up top.
 *
 * The acronym leg goes through findAcronym() so it carries the SAME guards the
 * real acronym stage does — acceptVA, acceptDOE, the filename stem, the
 * regulatory citation. A raw regex here made the department's acronym
 * corroborate itself in texts where that very acronym had already been judged
 * not to mean the department: the postal "VA" in "GSA Office of Information and
 * Technology, Reston, VA" vouched for Veterans Affairs, and a school-district
 * "DOE" vouched for Energy.
 */
function hasDepartmentCorroboration(dept: DepartmentDef, text: string): boolean {
  for (const phrase of dept.fullNames) if (phraseRegex(phrase).test(text)) return true;
  for (const rule of dept.acronyms) if (findAcronym(text, rule.term, rule.accept) >= 0) return true;
  for (const domain of dept.domains) if (domainRegex(domain).test(text)) return true;
  return false;
}

export interface DepartmentMatch {
  code: DepartmentCode;
  /** The literal string that produced the match — useful for audit/debug. */
  matched: string;
  /**
   * Precedence, strongest first: full-name → acronym → domain → fuzzy-name.
   * "fuzzy-name" is a full name with one misspelt token and is only ever
   * reached when nothing else in the text named a department at all.
   */
  via: "full-name" | "acronym" | "domain" | "fuzzy-name";
  /** Position in the cleaned text; lower wins between competing departments. */
  index: number;
}

/**
 * Full detail behind matchDepartment(). Exported for tests and for anything that
 * wants to show WHY a department was assigned.
 */
export function matchDepartmentDetail(agencyText: string | null | undefined): DepartmentMatch | null {
  if (!agencyText) return null;
  const text = stripPostalAddresses(String(agencyText));
  if (!text.trim()) return null;

  // ── Stage 1: full names (department first, then its bureaus) ──────────────
  // RULE: a full-name hit anywhere outranks every acronym anywhere. This is what
  // keeps "…Department of the Interior … Herndon, VA…" out of Veterans Affairs.
  let best: DepartmentMatch | null = null;
  // Where each department's full name turned up owned by a state or city. Kept
  // as SPANS so stage 2 can reject that body's own abbreviation standing next to
  // it and nothing else — see isStateNameRestatement().
  const stateOwnedSpans = new Map<DepartmentCode, Array<[number, number]>>();
  // Per-department, computed at most once, and only when a PARENT_REQUIRED_NAMES
  // entry actually turns up in that department's lists.
  const parentNamedCache = new Map<DepartmentCode, boolean>();
  const parentNamed = (dept: DepartmentDef) => {
    let v = parentNamedCache.get(dept.code);
    if (v === undefined) parentNamedCache.set(dept.code, (v = hasDepartmentCorroboration(dept, text)));
    return v;
  };
  for (const dept of DEPARTMENTS) {
    for (const phrase of [...dept.fullNames, ...dept.subAgencyNames]) {
      // A generic office title ("Office of Information and Technology") names no
      // department by itself, so it only counts when the department is named
      // independently — otherwise GSA's, DOJ's and NASA's are all filed as VA's.
      if (PARENT_REQUIRED_NAMES.has(phrase) && !parentNamed(dept)) continue;
      const { index: idx, blockedSpans } = scanFullName(text, phrase);
      if (blockedSpans.length) {
        const spans = stateOwnedSpans.get(dept.code);
        if (spans) spans.push(...blockedSpans);
        else stateOwnedSpans.set(dept.code, blockedSpans);
      }
      if (idx < 0) continue;
      // Earliest mention wins; ties fall to DEPARTMENTS declaration order,
      // because `best` is only replaced on a STRICTLY smaller index.
      if (!best || idx < best.index) best = { code: dept.code, matched: phrase, via: "full-name", index: idx };
    }
  }
  if (best) return best;

  // ── Stage 2: acronyms, case-sensitive, guarded ────────────────────────────
  for (const dept of DEPARTMENTS) {
    // This department's name appeared, but as a STATE's ("Minnesota Department
    // of Transportation"). The acronym STANDING NEXT TO that name is the same
    // state body abbreviated, so it must not come back in through the acronym
    // door — but an acronym elsewhere in the cell is a separate mention and is
    // judged on its own merits. Applied per occurrence, inside accept(), so
    // "Minnesota Department of Transportation (DOT) … and the U.S. DOT" still
    // resolves. See isStateNameRestatement().
    const blockedSpans = stateOwnedSpans.get(dept.code);
    // Computed at most once per department, and only when a collision-prone
    // acronym actually appears in the list. The PARENT-NAMED half only — the
    // per-acronym mission-vocabulary half is checked separately below, because
    // it differs for every rule.
    let parentNamed: boolean | null = null;
    // Department-level acronyms are ALSO guarded against a state/county/city
    // owner immediately in front of them ("Virginia DOT", "Mn/DOT", "Texas
    // HHS"). Sub-agency acronyms are not: FAA/NIH/BLM have no state analogue.
    const candidates: Array<[AcronymRule, boolean]> = [
      ...dept.acronyms.map((rule) => [rule, true] as [AcronymRule, boolean]),
      ...dept.subAgencyAcronyms.map((rule) => [rule, false] as [AcronymRule, boolean]),
    ];
    for (const [rule, guardJurisdiction] of candidates) {
      // A collision-prone acronym needs EITHER its parent department named in
      // the same text, OR its own mission vocabulary. Requiring the parent
      // alone was a false-negative machine: "CMS Interoperability and Prior
      // Authorization API", "NPS park pass e-commerce platform" and "FTA
      // Section 5307 transit grant" name no parent anywhere, because inside the
      // government the parent is implicit — and every one of them returned
      // null, which is the pursuit vanishing from the user's filter entirely.
      if (rule.needsCorroboration) {
        // A named commercial owner of the acronym ("IHS Markit", "CDC
        // Software") settles it on its own — such a row says "tribal" or
        // "public health" for reasons of its own, and mission vocabulary must
        // not rescue it.
        if (rule.civilianHomonym?.test(text)) continue;
        parentNamed ??= hasDepartmentCorroboration(dept, text);
        if (!parentNamed && !rule.corroboratedBy?.test(text)) continue;
      }
      const accept = (ctx: AcronymContext) => {
        // The row DEFINED this acronym as something else right where it sits
        // ("Content Management System (CMS)"). Checked per-occurrence, so a
        // later genuine use in the same row can still match.
        if (rule.needsCorroboration && isGlossedAsSomethingElse(rule.term, ctx.before)) return false;
        if (rule.accept && !rule.accept(ctx)) return false;
        // THIS occurrence is the state body's own abbreviation, sitting right
        // beside the state-owned full name: "…Transportation (Mn/DOT)".
        if (blockedSpans && isStateNameRestatement(ctx.full, ctx.start, ctx.end, blockedSpans)) return false;
        // accept() proved federal ownership by itself ("DC VA Medical Center").
        if (rule.provesFederal) return true;
        return !guardJurisdiction || !isJurisdictionOwnedAcronym(ctx.beforeAll);
      };
      const idx = findAcronym(text, rule.term, accept);
      if (idx < 0) continue;
      if (!best || idx < best.index) best = { code: dept.code, matched: rule.term, via: "acronym", index: idx };
    }
  }
  if (best) return best;

  // ── Stage 3: .gov domains in the POC block ────────────────────────────────
  // Last resort, and only reached when the text names no department at all.
  // Several real rows are a bare contact block whose ONLY signal is the email
  // domain ("dana.whitfield.ctr@dot.gov").
  for (const dept of DEPARTMENTS) {
    // No state/local suppression here. A federal .gov domain is INDEPENDENT
    // evidence — a state DOT's contact is never @dot.gov, and domainRegex()'s
    // lookbehind already keeps "danvilleva.gov" and "mndot.gov" out — so a
    // state body naming its federal partner's contact must still resolve. This
    // is what isJurisdictionOwnedAcronym()'s own doc comment promises: "a
    // genuinely federal row with a @dot.gov contact is recovered even if its
    // only acronym sat next to a city name".
    for (const domain of dept.domains) {
      const m = domainRegex(domain).exec(text);
      if (!m) continue;
      if (!best || m.index < best.index) best = { code: dept.code, matched: domain, via: "domain", index: m.index };
    }
  }
  if (best) return best;

  // ── Stage 4: a full name with ONE misspelt token ──────────────────────────
  // Nothing above matched, so there is no exact answer to protect. These cells
  // are typed by hand and a single slipped letter in "Transportation" should not
  // make the row invisible in the department filter. See the section header.
  const tokens = tokenizeForFuzzy(text);
  for (const dept of DEPARTMENTS) {
    // No state/local suppression here either: scanFuzzyName() runs
    // JURISDICTION_PREFIX against every candidate itself, so a typo'd "Virginia
    // Deptartment of Transportation" is still rejected — at the occurrence that
    // is actually state-owned, and only that one.
    for (const phrase of [...dept.fullNames, ...dept.subAgencyNames]) {
      if (PARENT_REQUIRED_NAMES.has(phrase) && !parentNamed(dept)) continue;
      const idx = scanFuzzyName(text, tokens, phrase);
      if (idx < 0) continue;
      if (!best || idx < best.index) best = { code: dept.code, matched: phrase, via: "fuzzy-name", index: idx };
    }
  }
  return best;
}

/**
 * Assign one of the five priority departments to a free-text agency string, or
 * null when none of them is clearly named.
 *
 * Returning null is the correct and common answer: the crawler sees DOJ, GSA,
 * USDA, HUD, Navy, NSF, city and state portals every day. The five departments
 * are a FILTER and a scoring priority, never a gate on what may be crawled — so
 * this function must never guess.
 */
export function matchDepartment(agencyText: string | null | undefined): DepartmentCode | null {
  return matchDepartmentDetail(agencyText)?.code ?? null;
}

/**
 * Department for a stored/crawled opportunity.
 *
 * The agency field is tried FIRST and its verdict stands when it names one of
 * the five. When it does NOT — which includes the case where it names some other
 * agency entirely — the title/description is brought in as well.
 *
 * WHY THE FALLBACK FIRES ON "NO MATCH" AND NOT MERELY ON "EMPTY". Six of the
 * user's own 71 rows are GSA eBuy / MRAS notices. Their agency column is the
 * market-research desk ("Gsa Market Research … rfi@research.gsa.gov") while the
 * actual customer is named only in the description: "DOT - Technology Transfer
 * Program - MRAS", "HHS ACF - Data Analytics Support - MRAS", "DOI - Secure AI
 * Assistant …", "Department of Energy EIA - IT Service Desk Support". Treating
 * a non-matching agency as authoritative filed all four as null, i.e. invisible
 * in the exact filter the user asked for.
 *
 * AND WHY THE TWO ARE MATCHED TOGETHER, NOT THE TITLE ALONE. The agency block
 * carries NEGATIVE evidence that the title lacks. Sheet rows 7 and 45 are New
 * York City Department of Education solicitations: the description says "DOE"
 * with no other context, but the agency block says "tbenne2@schools.nyc.gov".
 * Matching the concatenation lets acceptDOE() see the school-district evidence
 * and correctly return null instead of confidently mislabelling them Energy.
 */
export function departmentForOpportunity(
  agency: string | null | undefined,
  title?: string | null,
): DepartmentCode | null {
  const fromAgency = matchDepartment(agency);
  if (fromAgency) return fromAgency;
  const t = (title ?? "").trim();
  if (!t) return null;
  const a = (agency ?? "").trim();
  return matchDepartment(a ? `${a}\n${t}` : t);
}
