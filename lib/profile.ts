import { ghl } from "./ghl.js";

/**
 * A client's business profile. Each client's answers live in THEIR GHL sub-account as
 * Custom Values (Settings > Custom Values) named "AI Business Name", "AI Trade", etc.
 * The bot reads them on every message, so edits in GHL take effect immediately.
 * Anything left blank falls back to the Vercel environment variables, then to safe defaults.
 */
export interface Profile {
  businessName: string;
  trade: string;
  services: string;
  notOffered: string;
  serviceArea: string;
  outsideArea: string;
  hours: string;
  afterHours: string;
  pricing: string;
  jobLength: string;
  qualifying: string;
  emergencies: string;
  tone: string;
  extraInfo: string;
  /** Which outcomes the bot offers: "both" (default), "callback" only, or "booking" only. */
  options: "both" | "callback" | "booking";
  calendarId: string;
  timezone: string;
}

/** Custom Value name in GHL -> profile key. The setup script creates these for each client. */
export const PROFILE_FIELDS: { name: string; key: keyof Profile; question: string }[] = [
  { name: "AI Business Name", key: "businessName", question: "Business name, exactly as customers should see it" },
  { name: "AI Trade", key: "trade", question: "Trade, e.g. plumber, electrician, painter, carpenter" },
  { name: "AI Services", key: "services", question: "Services you offer" },
  { name: "AI Services Not Offered", key: "notOffered", question: "Jobs you DON'T do" },
  { name: "AI Service Area", key: "serviceArea", question: "Suburbs / postcodes / region you cover" },
  { name: "AI Outside Area", key: "outsideArea", question: "What to do with leads outside your area" },
  { name: "AI Hours", key: "hours", question: "Normal business hours" },
  { name: "AI After Hours", key: "afterHours", question: "After-hours / emergency work and any extra charge; what to tell people who ask for a call outside hours" },
  { name: "AI Pricing", key: "pricing", question: "Call-out fee or pricing the bot MAY mention (leave blank to never mention prices)" },
  { name: "AI Job Length", key: "jobLength", question: "How long a typical visit/quote takes, and notice needed" },
  { name: "AI Qualifying Questions", key: "qualifying", question: "What you need to know about a job before going out (e.g. photos, owner or renter, access, budget)" },
  { name: "AI Emergencies", key: "emergencies", question: "What counts as an emergency for you, and how to handle it" },
  { name: "AI Tone", key: "tone", question: "Tone: casual or formal; words to use or avoid" },
  { name: "AI Extra Info", key: "extraInfo", question: "Licence number, guarantees, payment methods, common questions and answers" },
  { name: "AI Options", key: "options", question: "Offer: both (callback or booking), callback, or booking" },
  { name: "AI Calendar ID", key: "calendarId", question: "GHL calendar ID for bookings (filled in during setup)" },
  { name: "AI Timezone", key: "timezone", question: "Timezone, e.g. Australia/Brisbane" },
];

export function defaultProfile(): Profile {
  return {
    businessName: process.env.BUSINESS_NAME || "our team",
    trade: process.env.BUSINESS_TRADE || "home maintenance (carpentry, plumbing, electrical, painting, general repairs and similar)",
    services: "",
    notOffered: "",
    serviceArea: "",
    outsideArea: "",
    hours: "",
    afterHours: "",
    pricing: "",
    jobLength: "",
    qualifying: "",
    emergencies: "",
    tone: "",
    extraInfo: "",
    options: "both",
    calendarId: process.env.GHL_CALENDAR_ID || "",
    timezone: process.env.TIMEZONE || "Australia/Sydney",
  };
}

function normaliseOptions(v: string): Profile["options"] {
  const s = v.toLowerCase();
  if (s.includes("both") || (s.includes("call") && s.includes("book"))) return "both";
  if (s.includes("call")) return "callback";
  if (s.includes("book")) return "booking";
  return "both";
}

export async function loadProfile(locationId: string): Promise<Profile> {
  const profile = defaultProfile();
  try {
    const r = await ghl(`/locations/${locationId}/customValues`);
    const values: { name?: string; value?: string }[] = r.customValues ?? [];
    for (const f of PROFILE_FIELDS) {
      const v = values.find((cv) => cv.name?.trim().toLowerCase() === f.name.toLowerCase())?.value?.trim();
      if (!v) continue;
      if (f.key === "options") profile.options = normaliseOptions(v);
      else (profile as any)[f.key] = v;
    }
  } catch (e: any) {
    // Missing token scope or GHL hiccup: carry on with the fallbacks rather than going silent.
    console.warn("could not load business profile, using defaults", e.message);
  }
  return profile;
}
