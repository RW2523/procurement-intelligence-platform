import type { Connector } from "@/lib/types";
// Federal
import { samConnector } from "./sam";
// States / municipalities
import { akConnector } from "./ak";
import { arConnector } from "./ar";
import { ksConnector } from "./ks";
import { kyConnector } from "./ky";
import { laConnector } from "./la";
import { maConnector } from "./ma";
import { moConnector } from "./mo";
import { msConnector } from "./ms";
import { mtConnector } from "./mt";
import { ncConnector } from "./nc";
import { okConnector } from "./ok";
import { paConnector } from "./pa";
import { phxConnector } from "./phx";
import { sdConnector } from "./sd";
import { tnConnector } from "./tn";
import { txConnector } from "./tx";
import { wvConnector } from "./wv";
import { wyConnector } from "./wy";

/**
 * connector_key (on the sources row) → Connector implementation.
 *
 * Every connector here was verified against the live portal — each returns real
 * solicitations over plain HTTP (either server-rendered HTML parsed with cheerio,
 * or the portal's underlying JSON API). Sources whose `connector_key` is absent
 * from this map are carried in the DB with status `needs_connector`: tracked and
 * visible, but skipped by the crawler.
 *
 * Deliberately NOT included: North Dakota (public.ndbuys.nd.gov). It is an Ivalua
 * portal behind a browser-check + reCAPTCHA Enterprise interstitial, and its
 * robots.txt disallows the bid paths. We do not circumvent bot protection or
 * robots directives — it needs an official feed/API or manual entry instead.
 */
export const CONNECTORS: Record<string, Connector> = {
  sam: samConnector, // Federal — SAM.gov (requires SAM_GOV_API_KEY)
  ak: akConnector, // Alaska — IRIS VSS
  ar: arConnector, // Arkansas — OSP
  ks: ksConnector, // Kansas — PeopleSoft
  ky: kyConnector, // Kentucky — CGI Advantage VSS
  la: laConnector, // Louisiana — LaPAC
  ma: maConnector, // Massachusetts — COMMBUYS
  mo: moConnector, // Missouri — Oracle Fusion
  ms: msConnector, // Mississippi — DFA
  mt: mtConnector, // Montana — Jaggaer/SciQuest
  nc: ncConnector, // North Carolina — eVP
  ok: okConnector, // Oklahoma — PeopleSoft
  pa: paConnector, // Pennsylvania — eMarketplace
  phx: phxConnector, // Phoenix, AZ — OpenGov
  sd: sdConnector, // South Dakota
  tn: tnConnector, // Tennessee — CPO
  tx: txConnector, // Texas — ESBD
  wv: wvConnector, // West Virginia — wvOASIS
  wy: wyConnector, // Wyoming — PublicPurchase
};

export function getConnector(key: string | null | undefined): Connector | null {
  if (!key) return null;
  return CONNECTORS[key] ?? null;
}

export function hasConnector(key: string | null | undefined): boolean {
  return Boolean(key && CONNECTORS[key]);
}
