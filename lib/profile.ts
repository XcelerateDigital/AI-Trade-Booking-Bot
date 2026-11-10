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
  afterHoursCallbacks: string;
  timezone: string;
  pricing: string;
  jobLength: string;
  notice: string;
  qualifying: string;
  /** Which outcomes the bot offers: "both" (default), "callback" only, or "booking" only. */
  options: "both" | "callback" | "booking";
  emergencies: string;
  tone: string;
  licence: string;
  guarantees: string;
  payments: string;
  faqs: string;
  extraInfo: string;
  calendarId: string;
  /** Used by the GHL alert workflows (via custom values), not by the bot's replies. */
  alertMobile: string;
  emergencyContacts: string;
}

/**
 * Custom Value name in GHL -> profile key. `q` is the question number in the
 * "AI Booking Bot – Client Questionnaire" doc, so each answer maps straight across.
 * The setup script creates these for each client.
 */
export const PROFILE_FIELDS: { q?: number; name: string; key: keyof Profile; question: string }[] = [
  { q: 1, name: "AI Business Name", key: "businessName", question: "Business name, exactly as customers should see it" },
  { q: 2, name: "AI Trade", key: "trade", question: "Your trade" },
  { q: 3, name: "AI Services", key: "services", question: "Services you offer" },
  { q: 4, name: "AI Services Not Offered", key: "notOffered", question: "Jobs you don't do (the assistant will politely decline these)" },
  { q: 5, name: "AI Service Area", key: "serviceArea", question: "Suburbs, postcodes or region you cover" },
  { q: 6, name: "AI Outside Area", key: "outsideArea", question: "What should the assistant say to leads outside your area?" },
  { q: 7, name: "AI Hours", key: "hours", question: "Normal business hours" },
  { q: 8, name: "AI After Hours", key: "afterHours", question: "Do you take after-hours or emergency work? Any extra charge?" },
  { q: 9, name: "AI After Hours Callbacks", key: "afterHoursCallbacks", question: "If someone asks for a call outside your hours, what should we tell them?" },
  { q: 10, name: "AI Timezone", key: "timezone", question: "Your timezone" },
  { q: 11, name: "AI Pricing", key: "pricing", question: "Any call-out fee or prices the assistant may mention" },
  { q: 12, name: "AI Job Length", key: "jobLength", question: "How long does a typical quote or visit take?" },
  { q: 13, name: "AI Notice Needed", key: "notice", question: "How much notice do you need for a booking?" },
  { q: 14, name: "AI Qualifying Questions", key: "qualifying", question: "Extra questions to ask every lead" },
  { q: 15, name: "AI Options", key: "options", question: "Should leads be offered a callback, a booked visit, or both?" },
  { q: 17, name: "AI Alert Mobile", key: "alertMobile", question: "Mobile number(s) to text when a lead books or asks for a callback" },
  { q: 18, name: "AI Emergencies", key: "emergencies", question: "What counts as an emergency for you?" },
  { q: 19, name: "AI Emergency Contacts", key: "emergencyContacts", question: "Who should be alerted for emergencies?" },
  { q: 20, name: "AI Tone", key: "tone", question: "Tone: casual or formal? Any words to use or avoid?" },
  { q: 21, name: "AI Licence", key: "licence", question: "Licence number" },
  { q: 22, name: "AI Guarantees", key: "guarantees", question: "Guarantees or warranties" },
  { q: 23, name: "AI Payment Methods", key: "payments", question: "Payment methods" },
  { q: 24, name: "AI FAQs", key: "faqs", question: "Common questions customers ask, and your answers" },
  { name: "AI Extra Info", key: "extraInfo", question: "Anything else the assistant should know (optional)" },
  { name: "AI Calendar ID", key: "calendarId", question: "GHL calendar ID for bookings (filled in during setup from Q16's Google account)" },
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
    afterHoursCallbacks: "",
    timezone: process.env.TIMEZONE || "Australia/Sydney",
    pricing: "",
    jobLength: "",
    notice: "",
    qualifying: "",
    options: "both",
    emergencies: "",
    tone: "",
    licence: "",
    guarantees: "",
    payments: "",
    faqs: "",
    extraInfo: "",
    calendarId: process.env.GHL_CALENDAR_ID || "",
    alertMobile: "",
    emergencyContacts: "",
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
