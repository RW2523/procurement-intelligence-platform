import type { Connector } from "@/lib/types";
import { ncConnector } from "./nc";
import { tnConnector } from "./tn";
import { arConnector } from "./ar";
import { paConnector } from "./pa";
import { maConnector } from "./ma";

/** connector_key (on the sources row) → Connector implementation. */
export const CONNECTORS: Record<string, Connector> = {
  nc: ncConnector,
  tn: tnConnector,
  ar: arConnector,
  pa: paConnector,
  ma: maConnector,
};

export function getConnector(key: string | null | undefined): Connector | null {
  if (!key) return null;
  return CONNECTORS[key] ?? null;
}

export function hasConnector(key: string | null | undefined): boolean {
  return Boolean(key && CONNECTORS[key]);
}
