/**
 * Load a client's business profile into THEIR GHL sub-account.
 *
 *   GHL_TOKEN=pit-xxxx npx tsx scripts/setup-client.ts clients/brush-bros.json          (preview only)
 *   GHL_TOKEN=pit-xxxx npx tsx scripts/setup-client.ts clients/brush-bros.json --apply  (make the changes)
 *
 * It creates or updates the "AI ..." Custom Values the bot reads, and creates the lead-qualifier
 * contact fields (Service Required, Customer Suburb, Urgency, ...) if they don't exist yet.
 * The token is the client's Private Integration token and needs: View/Edit Custom Values,
 * View/Edit Custom Fields. Nothing is ever deleted.
 */
import { readFileSync } from "node:fs";
import { PROFILE_FIELDS } from "../lib/profile";
import { LEAD_FIELDS } from "../lib/fields";
import { ghl } from "../lib/ghl";

const [file, flag] = process.argv.slice(2);
const apply = flag === "--apply";
if (!file) {
  console.error("Usage: GHL_TOKEN=pit-... npx tsx scripts/setup-client.ts clients/<client>.json [--apply]");
  process.exit(1);
}
if (!process.env.GHL_TOKEN) {
  console.error("Set GHL_TOKEN to the client's Private Integration token.");
  process.exit(1);
}
process.env.GHL_API_TOKEN = process.env.GHL_TOKEN;

const client = JSON.parse(readFileSync(file, "utf8"));
const locationId: string = client.locationId;
const answers: Record<string, string> = client.profile ?? {};
if (!locationId || locationId.startsWith("PASTE")) throw new Error(`${file}: set "locationId" (from the GHL URL: /v2/location/<this>/...)`);

const known = new Set(PROFILE_FIELDS.map((f) => f.name));
for (const name of Object.keys(answers)) if (!known.has(name)) console.warn(`! Unknown field "${name}" (ignored). Valid names: ${[...known].join(", ")}`);

console.log(`${apply ? "APPLYING" : "PREVIEW (add --apply to make changes)"} for location ${locationId}\n`);

// 1. Custom Values (the business profile)
const existing: { id: string; name: string; value: string }[] = (await ghl(`/locations/${locationId}/customValues`)).customValues ?? [];
for (const f of PROFILE_FIELDS) {
  const value = String(answers[f.name] ?? "").trim();
  const found = existing.find((cv) => cv.name?.trim().toLowerCase() === f.name.toLowerCase());
  if (!value && !found) {
    console.log(`  - ${f.name}: (blank, skipped)`);
    continue;
  }
  if (found && found.value === value) {
    console.log(`  = ${f.name}: unchanged`);
    continue;
  }
  console.log(`  ${found ? "~ update" : "+ create"} ${f.name}: ${value.slice(0, 70)}${value.length > 70 ? "..." : ""}`);
  if (!apply) continue;
  if (found) await ghl(`/locations/${locationId}/customValues/${found.id}`, { method: "PUT", body: JSON.stringify({ name: f.name, value }) });
  else await ghl(`/locations/${locationId}/customValues`, { method: "POST", body: JSON.stringify({ name: f.name, value }) });
}

// 2. Lead-qualifier contact fields
const fields: { name: string }[] = (await ghl(`/locations/${locationId}/customFields?model=contact`)).customFields ?? [];
console.log("");
for (const name of LEAD_FIELDS) {
  if (fields.some((f) => f.name?.trim().toLowerCase() === name.toLowerCase())) {
    console.log(`  = contact field "${name}" exists`);
    continue;
  }
  console.log(`  + create contact field "${name}"`);
  if (apply)
    await ghl(`/locations/${locationId}/customFields`, {
      method: "POST",
      body: JSON.stringify({ name, dataType: "TEXT", model: "contact" }),
    });
}

console.log(apply ? "\nDone." : "\nPreview only. Run again with --apply to make these changes.");
