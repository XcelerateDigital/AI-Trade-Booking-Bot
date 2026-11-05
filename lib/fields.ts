import { ghl } from "./ghl.js";

/**
 * Lead-qualifier fields written onto the GHL contact, so the tradie can see and filter leads.
 * These are contact Custom Fields in the client's GHL (Settings > Custom Fields). Any that
 * don't exist are simply skipped; the setup script creates them.
 */
export const LEAD_FIELDS = [
  "Service Required",
  "Customer Suburb",
  "Urgency",
  "Job Summary",
  "Preferred Time",
  "Callback Time",
] as const;
export type LeadField = (typeof LEAD_FIELDS)[number];

const cache = new Map<string, { at: number; ids: Map<string, string> }>();

async function fieldIds(locationId: string): Promise<Map<string, string>> {
  const hit = cache.get(locationId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ids;
  const r = await ghl(`/locations/${locationId}/customFields?model=contact`);
  const ids = new Map<string, string>();
  for (const f of r.customFields ?? []) if (f.name && f.id) ids.set(String(f.name).trim().toLowerCase(), f.id);
  cache.set(locationId, { at: Date.now(), ids });
  return ids;
}

/** Best effort: never let a field update break the conversation. */
export async function setLeadFields(locationId: string, contactId: string, values: Partial<Record<LeadField, string | undefined>>) {
  try {
    const ids = await fieldIds(locationId);
    const customFields = Object.entries(values)
      .filter(([, v]) => v)
      .map(([name, v]) => ({ id: ids.get(name.toLowerCase()), field_value: v }))
      .filter((f) => f.id);
    if (!customFields.length) return;
    await ghl(`/contacts/${contactId}`, { method: "PUT", body: JSON.stringify({ customFields }) });
  } catch (e: any) {
    console.warn("could not update lead fields", e.message);
  }
}
