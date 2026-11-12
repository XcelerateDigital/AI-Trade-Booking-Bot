import assert from "node:assert/strict";
// A slow AI never leaves the lead with no reply; booking + callback in one message tags both.
process.env.ANTHROPIC_API_KEY = "k"; process.env.GHL_API_TOKEN = "t";
const { generateReply } = await import("../lib/ai");
const { defaultProfile } = await import("../lib/profile");
const tags: string[] = []; const notes: string[] = []; let script: any[] = []; let turn = 0; let slow = false;
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = String(url); const j = (o: any) => new Response(JSON.stringify(o), { status: 200 });
  if (u.includes("/tags")) { tags.push(...JSON.parse(init.body).tags); return j({}); }
  if (u.includes("/notes")) { notes.push(JSON.parse(init.body).body); return j({}); }
  if (u.includes("/free-slots")) return j({ "2026-11-17": { slots: ["2026-11-17T10:00:00+10:00"] } });
  if (u.includes("anthropic")) {
    if (slow) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" }))));
    return j(script[turn++]);
  }
  return j({});
}) as any;
const profile = { ...defaultProfile(), calendarId: "cal" };
const tr = [{ direction: "inbound", body: "Can I book next Tuesday 10am but can someone call me tomorrow at 11am about pricing", attachments: [] }] as any;

const keepAlive = setInterval(() => {}, 1000); // a real request keeps Node alive; the mock needs this
// 1. AI too slow -> backup within the time budget (here: the lead asked for a call -> recorded)
slow = true;
const t0 = Date.now();
const r1 = await generateReply(tr, { contactId: "c", locationId: "l", profile, deadline: Date.now() + 4_000 } as any);
assert.ok(Date.now() - t0 < 6_000, "finished inside the budget");
assert.ok(r1.length > 0, "still sends a reply");
assert.ok(tags.includes("ai-callback"));
assert.ok(notes.some((n) => /took too long/.test(n)));

// 2. booking AND callback -> both done, both tags (both alerts fire)
slow = false; tags.length = 0; turn = 0;
script = [
  { stop_reason: "tool_use", content: [
    { type: "tool_use", id: "1", name: "book_appointment", input: { start_time: "2026-11-17T10:00:00+10:00", summary: "paint bedroom" } },
    { type: "tool_use", id: "2", name: "request_callback", input: { callback_time: "tomorrow 11am", summary: "pricing" } } ] },
  { stop_reason: "end_turn", content: [{ type: "text", text: "Booked Tuesday 10am, and someone will call you tomorrow at 11am." }] },
];
const r2 = await generateReply(tr, { contactId: "c", locationId: "l", profile } as any);
assert.match(r2, /Tuesday 10am/);
assert.ok(tags.includes("ai-booked") && tags.includes("ai-callback"), "both alerts: " + tags);
clearInterval(keepAlive);
console.log("time budget + both-outcomes tests passed");
