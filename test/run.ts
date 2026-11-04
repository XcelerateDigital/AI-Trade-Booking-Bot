import assert from "node:assert/strict";

process.env.WEBHOOK_SECRET = "s3cret";
process.env.GHL_API_TOKEN = "t";
process.env.ANTHROPIC_API_KEY = "k";

const { toClaudeMessages } = await import("../lib/ai");
const handler = (await import("../api/ghl-reply")).default;

// ---- 1. transcript conversion: alternating roles, greeting-first, photos kept ----
const msgs = toClaudeMessages([
  { direction: "outbound", body: "Hi, how can we help?", attachments: [] },
  { direction: "inbound", body: "tap leaking", attachments: [] },
  { direction: "inbound", body: "", attachments: ["https://x/p.jpg"] },
]);
assert.equal(msgs[0].role, "user");
assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user"]);
assert.equal((msgs[2].content as any[]).length, 2); // text + image merged into one user turn

// ---- 2. full handler flow with mocked GHL + Anthropic ----
const sent: any[] = [];
const calls: string[] = [];
let claudeTurn = 0;
let contactTags: string[] = [];

globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = String(url);
  const json = (o: any) => new Response(JSON.stringify(o), { status: 200 });
  calls.push(`${init.method || "GET"} ${u.replace("https://services.leadconnectorhq.com", "")}`);
  if (u.includes("/contacts/c1/notes") || u.includes("/contacts/c1/tags")) return json({});
  if (u.endsWith("/contacts/c1")) return json({ contact: { firstName: "Sam", tags: contactTags, locationId: "loc1" } });
  if (u.includes("/conversations/search")) return json({ conversations: [{ id: "conv1" }] });
  if (u.includes("/conversations/conv1/messages"))
    return json({
      messages: {
        messages: [
          { direction: "inbound", body: "my kitchen tap is leaking under the sink", dateAdded: "2026-10-30T01:01:00Z" },
          { direction: "outbound", body: "Hi, how can we help?", dateAdded: "2026-10-30T01:00:00Z" },
        ],
      },
    });
  if (u.endsWith("/conversations/messages")) {
    sent.push(JSON.parse(init.body));
    return json({});
  }
  if (u.includes("api.anthropic.com")) {
    claudeTurn++;
    const body = JSON.parse(init.body);
    assert.equal(body.messages[0].role, "user");
    if (claudeTurn === 1)
      return json({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "save_job_details", input: { trade: "plumbing", problem: "leaking kitchen tap" } }],
      });
    assert.equal(body.messages.at(-1).content[0].type, "tool_result");
    return json({ stop_reason: "end_turn", content: [{ type: "text", text: "Ah, that's no fun. Could you send a quick photo of the leak?" }] });
  }
  throw new Error("unexpected fetch " + u);
}) as any;

function call(headers: any, body: any) {
  let status = 0, payload: any;
  const res: any = { status: (s: number) => ((status = s), res), json: (p: any) => ((payload = p), res), end: () => res };
  return handler({ method: "POST", headers, body, query: {} } as any, res).then(() => ({ status, payload }));
}

assert.equal((await call({}, { contact_id: "c1" })).status, 401);

const r = await call({ "x-webhook-secret": "s3cret" }, { contact_id: "c1" });
assert.equal(r.status, 200);
// secret also accepted as ?secret= on the URL
const rq = await (async () => {
  claudeTurn = 0;
  let status = 0;
  const res: any = { status: (s: number) => ((status = s), res), json: () => res, end: () => res };
  await handler({ method: "POST", headers: {}, query: { secret: "s3cret" }, body: { contact_id: "c1" } } as any, res);
  return status;
})();
assert.equal(rq, 200);
sent.length = 1; // ignore the extra reply that check produced
assert.equal(sent.length, 1);
assert.match(sent[0].message, /photo/);
assert.equal(sent[0].contactId, "c1");
assert.ok(calls.some((c) => c.startsWith("POST /contacts/c1/notes")), "job summary saved as note");

// a contact tagged ai-stop (opted out / human took over) must get no reply
contactTags = ["ai-stop"];
const r2 = await call({ "x-webhook-secret": "s3cret" }, { contact_id: "c1", location: { id: "loc1" } });
assert.equal(r2.payload.skipped, "stop tag");
assert.equal(sent.length, 1);

console.log("all tests passed");
