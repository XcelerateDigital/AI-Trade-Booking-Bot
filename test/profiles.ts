import assert from "node:assert/strict";

// Two pretend clients on ONE bot: a plumber and a painter, each with their own GHL token.
process.env.WEBHOOK_SECRET = "s";
process.env.ANTHROPIC_API_KEY = "k";
process.env.GHL_API_TOKEN = "pit-default";
process.env.GHL_TOKENS = JSON.stringify({ locPlumb: "pit-plumb", locPaint: "pit-paint" });
delete process.env.GHL_CALENDAR_ID;

const handler = (await import("../api/ghl-reply")).default;
const { buildSystemPrompt } = await import("../lib/prompt");
const { defaultProfile } = await import("../lib/profile");

const CUSTOM_VALUES: Record<string, Record<string, string>> = {
  locPlumb: {
    "AI Business Name": "Coastline Plumbing",
    "AI Trade": "plumbing",
    "AI Services": "blocked drains, leaking taps, hot water systems",
    "AI Services Not Offered": "gas fitting, roofing",
    "AI Service Area": "Gold Coast, Tweed Heads",
    "AI Hours": "Mon-Fri 7am-4pm",
    "AI Pricing": "$99 call-out fee",
    "AI Calendar ID": "calPlumb",
    "AI Timezone": "Australia/Brisbane",
  },
  locPaint: {
    "AI Business Name": "Brush Bros Painting",
    "AI Trade": "painting",
    "AI Qualifying Questions": "inside or outside, how many rooms, owner or renter",
    "AI Options": "callback only",
    "AI Tone": "relaxed and friendly",
  },
};

type Call = { url: string; token: string; method: string; body?: any };
let calls: Call[] = [];
let claudeBodies: any[] = [];
let claudeScript: any[] = [];

globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = String(url);
  const j = (o: any) => new Response(JSON.stringify(o), { status: 200 });
  const token = String(init.headers?.Authorization || "").replace("Bearer ", "");
  calls.push({ url: u.replace("https://services.leadconnectorhq.com", ""), token, method: init.method || "GET", body: init.body && JSON.parse(init.body) });
  const loc = token === "pit-plumb" ? "locPlumb" : "locPaint";
  if (u.includes("/customValues")) return j({ customValues: Object.entries(CUSTOM_VALUES[loc]).map(([name, value], i) => ({ id: `cv${i}`, name, value })) });
  if (u.includes("/customFields"))
    return j({ customFields: ["Service Required", "Customer Suburb", "Urgency", "Job Summary", "Callback Time"].map((name, i) => ({ id: `f${i}`, name })) });
  if (/\/contacts\/c\d$/.test(u) && (init.method || "GET") === "GET") return j({ contact: { firstName: "Sam", tags: [], locationId: loc } });
  if (/\/contacts\/c\d$/.test(u)) return j({});
  if (u.includes("/notes") || u.includes("/tags")) return j({});
  if (u.includes("/conversations/search")) return j({ conversations: [{ id: "v" }] });
  if (u.includes("/conversations/v/messages"))
    return j({ messages: { messages: [{ direction: "inbound", body: "Sewage is overflowing in Burleigh, can someone ring me now", dateAdded: "1" }] } });
  if (u.endsWith("/conversations/messages")) return j({});
  if (u.includes("anthropic")) {
    claudeBodies.push(JSON.parse(init.body));
    return j(claudeScript.shift());
  }
  throw new Error("unexpected fetch " + u);
}) as any;

const res: any = { status: () => res, json: () => res, end: () => res };
const call = (location: string, contact: string) =>
  handler({ method: "POST", headers: { "x-webhook-secret": "s" }, query: {}, body: { contact_id: contact, location: { id: location } } } as any, res);

// ---- Plumber: emergency callback -> own token, own profile, fields + emergency tag ----
calls = []; claudeBodies = [];
claudeScript = [
  {
    stop_reason: "tool_use",
    content: [
      { type: "tool_use", id: "a", name: "save_job_details", input: { trade: "plumbing", problem: "sewage overflowing", urgency: "emergency", location: "Burleigh" } },
      { type: "tool_use", id: "b", name: "request_callback", input: { callback_time: "ASAP", summary: "sewage overflow Burleigh" } },
    ],
  },
  { stop_reason: "end_turn", content: [{ type: "text", text: "Yep, no worries! Someone from the team will give you a buzz right now." }] },
];
await call("locPlumb", "c1");
assert.ok(calls.every((c) => c.url.includes("anthropic") || c.token === "pit-plumb"), "plumber requests use the plumber's token only");
const sysPlumb = claudeBodies[0].system as string;
assert.match(sysPlumb, /Coastline Plumbing, a plumbing business/);
assert.match(sysPlumb, /\$99 call-out fee/);
assert.match(sysPlumb, /gas fitting, roofing/);
assert.match(sysPlumb, /Do NOT offer a call, a booking or a referral/);
assert.match(sysPlumb, /clearly a different trade/);
assert.match(sysPlumb, /Gold Coast, Tweed Heads/);
assert.match(sysPlumb, /Mon-Fri 7am-4pm/);
assert.ok(claudeBodies[0].tools.some((t: any) => t.name === "get_available_slots"), "plumber has a calendar, so booking tools are on");
const tags = calls.filter((c) => c.url.endsWith("/tags")).flatMap((c) => c.body.tags);
assert.ok(tags.includes("ai-emergency") && tags.includes("ai-callback") && tags.includes("trade-plumbing"), "tags: " + tags);
const fieldWrites = calls.filter((c) => c.method === "PUT" && c.url === "/contacts/c1").flatMap((c) => c.body.customFields);
const byId = Object.fromEntries(fieldWrites.map((f: any) => [f.id, f.field_value]));
assert.equal(byId.f1, "Burleigh"); // Customer Suburb
assert.equal(byId.f2, "emergency"); // Urgency
assert.equal(byId.f4, "ASAP"); // Callback Time
assert.match(byId.f0, /plumbing: sewage overflowing/); // Service Required

// ---- Painter: callback-only business, own token, qualifying questions, no calendar ----
calls = []; claudeBodies = [];
claudeScript = [{ stop_reason: "end_turn", content: [{ type: "text", text: "Ah, happy to help. Is it the inside or outside?" }] }];
await call("locPaint", "c2");
assert.ok(calls.every((c) => c.url.includes("anthropic") || c.token === "pit-paint"), "painter requests use the painter's token only");
const sysPaint = claudeBodies[0].system as string;
assert.match(sysPaint, /Brush Bros Painting, a painting business/);
assert.match(sysPaint, /inside or outside, how many rooms, owner or renter/);
assert.match(sysPaint, /only arranges callbacks/);
assert.match(sysPaint, /relaxed and friendly/);
assert.doesNotMatch(sysPaint, /Coastline|\$99/, "no leakage from the other client");
assert.doesNotMatch(sysPaint, /Prices: you may share/, "painter set no pricing");
assert.match(sysPaint, /Do not quote prices/);
assert.match(sysPaint, /Brush Bros Painting is a painting business/, "trade set -> other trades declined even with no not-offered list");
assert.ok(!claudeBodies[0].tools.some((t: any) => t.name === "get_available_slots"), "painter has no calendar booking tools");

// ---- No profile at all (custom values unreadable): falls back to env, still works ----
const p = defaultProfile();
const sysDefault = buildSystemPrompt({ canBook: false, nowLocal: "now", profile: p });
assert.match(sysDefault, /home maintenance/);
assert.doesNotMatch(sysDefault, /clearly a different trade/, "no trade set -> accept any job");
assert.match(sysDefault, /Would you like someone from the team to give you a call, or shall I book/);

console.log("profile tests passed");
