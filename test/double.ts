import assert from "node:assert/strict";
// Double-texting: two quick texts get ONE reply that covers both; duplicate webhooks don't double up.
process.env.REPLY_DELAY_MS = "0";
process.env.WEBHOOK_SECRET = "s"; process.env.GHL_API_TOKEN = "t"; process.env.ANTHROPIC_API_KEY = "k";
const handler = (await import("../api/ghl-reply")).default;
const res: any = { status: () => res, json: (o: any) => ((res.body = o), res), end: () => res };
const msg = (direction: string, body: string, at: string) => ({ direction, body, dateAdded: at });

async function run(transcripts: any[][], replies: string[]) {
  const sent: string[] = []; const prompts: any[] = []; let fetches = 0; let turn = 0;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url); const j = (o: any) => new Response(JSON.stringify(o), { status: 200 });
    if (u.includes("/tags") || u.includes("/notes") || u.includes("custom")) return j({});
    if (u.endsWith("/contacts/c1")) return j({ contact: { firstName: "Sam", tags: [], locationId: "l" } });
    if (u.includes("/conversations/search")) return j({ conversations: [{ id: "v" }] });
    if (u.includes("/conversations/v/messages")) return j({ messages: { messages: transcripts[Math.min(fetches++, transcripts.length - 1)] } });
    if (u.endsWith("/conversations/messages")) { sent.push(JSON.parse(init.body).message); return j({}); }
    if (u.includes("anthropic")) { prompts.push(JSON.parse(init.body)); return j({ stop_reason: "end_turn", content: [{ type: "text", text: replies[turn++] }] }); }
    throw new Error(u);
  }) as any;
  await handler({ method: "POST", headers: { "x-webhook-secret": "s" }, query: {}, body: { contact_id: "c1" } } as any, res);
  return { sent, prompts, result: res.body };
}

const A = msg("inbound", "My toilet is blocked", "1");
const B = msg("inbound", "it's overflowing!", "2");
const R = msg("outbound", "Ah no, ...", "3");

// 1. second text arrives during the wait -> this webhook stands down (the newer one answers both)
let r = await run([[A], [A, B]], ["x"]);
assert.deepEqual(r.sent, []); assert.equal(r.result.skipped, "newer message will be answered");
// 2. the newer webhook sees both texts and sends one reply
r = await run([[A, B], [A, B], [A, B]], ["Turn the water off at the toilet stop tap. What suburb are you in?"]);
assert.equal(r.sent.length, 1);
assert.match(JSON.stringify(r.prompts[0].messages), /blocked.*overflowing/s);
// 3. duplicate webhook: someone already replied during the wait -> stay quiet
r = await run([[A], [A, R]], ["x"]);
assert.deepEqual(r.sent, []); assert.equal(r.result.skipped, "already answered");
// 4. a text arrives while the AI is writing -> regenerate once, covering both, send ONE reply
r = await run([[A], [A], [A, B], [A, B]], ["reply to A only", "reply covering A and B"]);
assert.deepEqual(r.sent, ["reply covering A and B"]);
// 5. another reply went out while the AI was writing -> don't send a second one
r = await run([[A], [A], [A, R]], ["late reply"]);
assert.deepEqual(r.sent, []);
console.log("double-text tests passed");
