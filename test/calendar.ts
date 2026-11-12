import assert from "node:assert/strict";
// Calendar booking with a notice period and 30-minute slots (the case that fell back to a note).
process.env.ANTHROPIC_API_KEY = "k"; process.env.GHL_API_TOKEN = "t";
const { generateReply, noticeMs, spreadAcrossDays } = await import("../lib/ai");
const { defaultProfile } = await import("../lib/profile");

assert.equal(noticeMs("at least 24 hours"), 24 * 3_600_000);
assert.equal(noticeMs("2 hrs"), 2 * 3_600_000);
assert.equal(noticeMs("1 day"), 86_400_000);
assert.equal(noticeMs(""), 0);

// Free slots every 30 min, 8am-4pm, for the next 10 days (in UTC+10 = Brisbane).
const now = Date.now();
const slots: string[] = [];
for (let d = 0; d < 10; d++) for (let h = 8; h < 16; h += 0.5) {
  const day = new Date(now + d * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Australia/Brisbane" });
  const hh = String(Math.floor(h)).padStart(2, "0"), mm = h % 1 ? "30" : "00";
  const iso = `${day}T${hh}:${mm}:00+10:00`;
  if (Date.parse(iso) > now) slots.push(iso);
}
const byDate: Record<string, { slots: string[] }> = {};
for (const s of slots) (byDate[s.slice(0, 10)] ??= { slots: [] }).slots.push(s);

const calls: any[] = []; const results: string[] = []; let turn = 0; let script: any[] = [];
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = String(url); const j = (o: any) => new Response(JSON.stringify(o), { status: 200 });
  if (u.includes("/free-slots")) {
    const q = new URL(u).searchParams; const from = +q.get("startDate")!, to = +q.get("endDate")!;
    const out: any = {}; for (const [k, v] of Object.entries(byDate)) { const f = v.slots.filter((s) => Date.parse(s) >= from && Date.parse(s) <= to); if (f.length) out[k] = { slots: f }; }
    return j(out);
  }
  if (u.includes("/appointments")) { calls.push(JSON.parse(init.body)); return j({ id: "appt1" }); }
  if (u.includes("anthropic")) {
    const body = JSON.parse(init.body);
    const last = body.messages[body.messages.length - 1];
    for (const b of last.content ?? []) if (b.type === "tool_result") results.push(b.content);
    return j(script[turn++]);
  }
  return j({});
}) as any;

const profile = { ...defaultProfile(), calendarId: "cal1", timezone: "Australia/Brisbane", notice: "at least 24 hours" };
const tr = [{ direction: "inbound", body: "Monday 1pm would that work", attachments: [] }] as any;

// 1. next available: all >= 24h away, spread over several days (not 6 slots in the next 3 hours)
turn = 0; script = [
  { stop_reason: "tool_use", content: [{ type: "tool_use", id: "1", name: "get_available_slots", input: {} }] },
  { stop_reason: "end_turn", content: [{ type: "text", text: "I've got a few times" }] },
];
await generateReply(tr, { contactId: "c", locationId: "l", profile });
const offered = JSON.parse(results[0].split("\n")[0]).map((x: any) => x.iso);
assert.ok(offered.length >= 4, "several options");
assert.ok(offered.every((s: string) => Date.parse(s) >= now + 24 * 3_600_000 - 60_000), "all respect 24h notice");
assert.ok(new Set(offered.map((s: string) => s.slice(0, 10))).size >= 3, "spread across days");

// 2. the lead asks for a specific day/time -> check that day and book it into the calendar
const target = slots.find((s) => Date.parse(s) > now + 3 * 86_400_000 && s.includes("T13:00"))!;
const date = target.slice(0, 10);
turn = 0; results.length = 0; script = [
  { stop_reason: "tool_use", content: [{ type: "tool_use", id: "1", name: "get_available_slots", input: { date } }] },
  { stop_reason: "tool_use", content: [{ type: "tool_use", id: "2", name: "book_appointment", input: { start_time: target, summary: "paint fences" } }] },
  { stop_reason: "end_turn", content: [{ type: "text", text: "You're booked in for Monday at 1pm." }] },
];
const ctx: any = { contactId: "c", locationId: "l", profile };
const reply = await generateReply(tr, ctx);
const dayTimes = JSON.parse(results[0].split("\n")[0]).map((x: any) => x.iso);
assert.ok(dayTimes.includes(target), "1pm on that day is listed");
assert.ok(dayTimes.every((s: string) => s.startsWith(date)), "only that day");
assert.equal(calls.length, 1); assert.equal(calls[0].startTime, target); assert.equal(calls[0].calendarId, "cal1");
assert.equal(ctx.outcome, "booked");
assert.equal(reply, "You're booked in for Monday at 1pm.");

// 3. a day inside the notice period -> told none, offered others (no silent fallback to a note)
turn = 0; results.length = 0; script = [
  { stop_reason: "tool_use", content: [{ type: "tool_use", id: "1", name: "get_available_slots", input: { date: slots[0].slice(0, 10) } }] },
  { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
];
await generateReply(tr, { contactId: "c", locationId: "l", profile });
assert.match(results[0], /No free times on .*allowing for at least 24 hours notice/);

const spread = spreadAcrossDays(["2026-01-01T08:00", "2026-01-01T08:30", "2026-01-01T09:00", "2026-01-02T10:00"], (s) => s.slice(0, 10));
assert.deepEqual(spread, ["2026-01-01T08:00", "2026-01-01T08:30", "2026-01-02T10:00"]);
console.log("calendar tests passed");
