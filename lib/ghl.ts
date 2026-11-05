import { AsyncLocalStorage } from "node:async_hooks";

const BASE = "https://services.leadconnectorhq.com";

/**
 * Each client (GHL sub-account / "location") has its own Private Integration token.
 * GHL_TOKENS is a JSON map of locationId -> token, e.g. {"ufcbt6ho...":"pit-..."}.
 * GHL_API_TOKEN is the fallback used when a location isn't listed (single-client setups).
 */
export function tokenFor(locationId?: string): string | undefined {
  if (locationId && process.env.GHL_TOKENS) {
    try {
      const map = JSON.parse(process.env.GHL_TOKENS);
      if (map[locationId]) return map[locationId];
    } catch {
      console.error("GHL_TOKENS is not valid JSON");
    }
  }
  return process.env.GHL_API_TOKEN;
}

// The token for the request being handled. AsyncLocalStorage keeps concurrent requests
// for different clients from ever using each other's token.
const store = new AsyncLocalStorage<{ token?: string }>();
export function withLocation<T>(locationId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return store.run({ token: tokenFor(locationId) }, fn);
}

// GHL versions its APIs per area: contacts/locations use 2021-07-28, conversations/calendars 2021-04-15.
function headers(path: string) {
  return {
    Authorization: `Bearer ${store.getStore()?.token ?? process.env.GHL_API_TOKEN}`,
    Version: path.startsWith("/contacts") || path.startsWith("/locations") ? "2021-07-28" : "2021-04-15",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export async function ghl<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers(path), ...(init.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL ${init.method || "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : ({} as T);
}

export interface ChatMessage {
  direction: "inbound" | "outbound";
  body: string;
  attachments: string[];
}

const IMAGE_RE = /\.(jpe?g|png|gif|webp)(\?|$)/i;

export async function findConversationId(contactId: string, locationId: string): Promise<string | null> {
  const r = await ghl(`/conversations/search?locationId=${locationId}&contactId=${contactId}`);
  return r.conversations?.[0]?.id ?? null;
}

/** Full SMS history, oldest first. GHL is the source of truth, so the bot needs no database. */
export async function getTranscript(conversationId: string): Promise<ChatMessage[]> {
  const r = await ghl(`/conversations/${conversationId}/messages?limit=60`);
  const raw: any[] = r.messages?.messages ?? r.messages ?? [];
  return raw
    .filter((m) => typeof m.body === "string" || m.attachments?.length)
    .map((m) => ({
      direction: m.direction === "inbound" ? "inbound" : "outbound",
      body: (m.body ?? "").trim(),
      attachments: ((m.attachments ?? []) as string[]).filter((u) => IMAGE_RE.test(u)),
      at: m.dateAdded as string,
    }))
    .sort((a, b) => (a.at < b.at ? -1 : 1))
    .map(({ at, ...rest }) => rest as ChatMessage);
}

export async function sendSms(contactId: string, message: string) {
  return ghl("/conversations/messages", {
    method: "POST",
    body: JSON.stringify({ type: "SMS", contactId, message }),
  });
}

export async function addNote(contactId: string, body: string) {
  return ghl(`/contacts/${contactId}/notes`, { method: "POST", body: JSON.stringify({ body }) });
}

export async function addTags(contactId: string, tags: string[]) {
  return ghl(`/contacts/${contactId}/tags`, { method: "POST", body: JSON.stringify({ tags }) });
}

export async function getContact(contactId: string) {
  const r = await ghl(`/contacts/${contactId}`);
  return r.contact as { firstName?: string; tags?: string[]; locationId?: string };
}

/** Returns up to `max` upcoming slots as ISO strings. */
export async function getFreeSlots(calendarId: string, days: number, tz: string, max = 6): Promise<string[]> {
  const start = Date.now();
  const end = start + days * 86_400_000;
  const r = await ghl(
    `/calendars/${calendarId}/free-slots?startDate=${start}&endDate=${end}&timezone=${encodeURIComponent(tz)}`,
  );
  const slots: string[] = [];
  for (const [key, val] of Object.entries<any>(r)) {
    if (key === "traceId") continue;
    slots.push(...(val?.slots ?? []));
  }
  return slots.sort().slice(0, max);
}

export async function bookAppointment(opts: {
  calendarId: string;
  locationId: string;
  contactId: string;
  startTime: string;
  title: string;
  notes: string;
}) {
  return ghl("/calendars/events/appointments", {
    method: "POST",
    body: JSON.stringify({
      calendarId: opts.calendarId,
      locationId: opts.locationId,
      contactId: opts.contactId,
      startTime: opts.startTime,
      title: opts.title,
      appointmentStatus: "confirmed",
      address: "",
      ignoreDateRange: false,
      toNotify: true,
      description: opts.notes,
    }),
  });
}
