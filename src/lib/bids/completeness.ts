/**
 * Which details a bid is still missing.
 *
 * Rows that arrive from a spreadsheet are only as complete as the cell someone
 * typed in a hurry. 14 of the operator's own 71 rows have no agency at all,
 * because the Agency/POC cell opened with a contact name instead of the
 * organisation; several have no due date because the cell held two dates or a
 * "???". None of that is a mapping failure — the information genuinely is not in
 * the file — so the app's job is to say so plainly and make it one click to fix,
 * rather than showing a silent blank.
 *
 * PURE: no database, no React. The bid list, the detail page and the edit form
 * all read the same definition, so "3 details missing" always means the same
 * three things.
 */

export type FieldWeight = "blocking" | "helpful";

export interface BidField {
  /** Column on public.opportunities. */
  key: string;
  /** What the operator calls it — matches their spreadsheet where one exists. */
  label: string;
  weight: FieldWeight;
  /** Why it is worth filling in. Shown next to the empty field. */
  why: string;
  input: "text" | "textarea" | "date" | "datetime" | "money" | "state" | "department" | "list";
}

/**
 * `blocking` = you cannot really work the bid without it: no deadline means no
 * reminder and no urgency score; no agency means it is invisible to the
 * department filter; no link means nobody can open the posting.
 * `helpful` = improves targeting and reporting but nothing breaks without it.
 */
export const BID_FIELDS: BidField[] = [
  { key: "due_date", label: "Bid deadline", weight: "blocking", input: "datetime",
    why: "Drives deadline reminders and the urgency score. Without it the bid never surfaces as due." },
  { key: "agency", label: "Agency", weight: "blocking", input: "text",
    why: "Who is buying. Also what the department filter reads — a blank agency hides the bid from it." },
  { key: "detail_url", label: "Link to the posting", weight: "blocking", input: "text",
    why: "Where the solicitation lives. Without it nobody can open it from here." },
  { key: "poc_name", label: "Contact name", weight: "helpful", input: "text",
    why: "Who to chase for a status update." },
  { key: "poc_email", label: "Contact email", weight: "helpful", input: "text",
    why: "Who to chase for a status update." },
  { key: "department", label: "Department", weight: "helpful", input: "department",
    why: "Groups the bid under DOT / DOI / DOE / VA / HHS on the department filter." },
  { key: "state", label: "State", weight: "helpful", input: "state",
    why: "Used by the state filter and by the targeting engine's jurisdiction scoring." },
  { key: "naics_code", label: "NAICS code", weight: "helpful", input: "text",
    why: "Feeds the targeting score and tells you whether the work is in your wheelhouse." },
  { key: "estimated_value", label: "Estimated value", weight: "helpful", input: "money",
    why: "Feeds the value-band score and lets the pipeline be totalled." },
  { key: "contract_vehicle", label: "Contract vehicle", weight: "helpful", input: "text",
    why: "SAM, GSA MAS, Jaggaer, and so on — scores higher when you already hold the vehicle." },
  { key: "q_and_a_deadline", label: "Questions due", weight: "helpful", input: "datetime",
    why: "The earlier deadline, and the one most often missed." },
  { key: "period_of_performance", label: "Period of performance", weight: "helpful", input: "text",
    why: "How long the work runs — needed to size the bid." },
];

/** A bid row, as far as completeness is concerned. Loose on purpose so the list
 *  page, the detail page and the API can all pass what they already have. */
export type BidLike = Record<string, unknown>;

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

export interface Missing {
  field: BidField;
}

/**
 * The fields this bid has not got. Order follows BID_FIELDS, so blocking gaps
 * are listed before merely helpful ones.
 */
export function missingFields(bid: BidLike): BidField[] {
  return BID_FIELDS.filter((f) => {
    // estimated_value counts as present if EITHER the number or the operator's
    // own wording is there — "1.96B BPA" is a real answer, not a gap.
    if (f.key === "estimated_value") {
      return isEmpty(bid.estimated_value) && isEmpty(bid.estimated_value_text);
    }
    // Same idea for the deadlines: a cell we could not parse into a timestamp
    // still told us something, and it is kept verbatim.
    if (f.key === "due_date") return isEmpty(bid.due_date) && isEmpty(bid.due_date_text);
    if (f.key === "q_and_a_deadline") {
      return isEmpty(bid.q_and_a_deadline) && isEmpty(bid.q_and_a_deadline_text);
    }
    return isEmpty(bid[f.key]);
  });
}

export function countMissing(bid: BidLike): { blocking: number; helpful: number; total: number } {
  const m = missingFields(bid);
  const blocking = m.filter((f) => f.weight === "blocking").length;
  return { blocking, helpful: m.length - blocking, total: m.length };
}

/** Short label for a chip in a list: "2 missing" / "1 needed". */
export function missingLabel(bid: BidLike): string | null {
  const { blocking, total } = countMissing(bid);
  if (!total) return null;
  return blocking ? `${blocking} needed` : `${total} missing`;
}

/** The columns a writer is allowed to set from the edit form. Anything outside
 *  this list is ignored by the API — the form must never become a way to write
 *  arbitrary columns. */
export const EDITABLE_KEYS = [
  ...BID_FIELDS.map((f) => f.key),
  // Not "missing"-tracked, but part of the same edit form.
  "title", "description", "sub_agency", "poc_phone", "set_asides",
  "estimated_value_text", "period_of_performance", "capture_notes",
  "outcome", "lessons_learned", "is_shared",
] as const;
