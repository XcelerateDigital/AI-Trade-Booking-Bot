import assert from "node:assert/strict";
process.env.WEBHOOK_SECRET="s"; process.env.GHL_API_TOKEN="t"; process.env.ANTHROPIC_API_KEY="k";
const handler = (await import("../api/ghl-reply")).default;
const res:any={status:()=>res,json:()=>res,end:()=>res};
async function run(replies:any[]) {
  const sent:string[]=[], tags:any[]=[], notes:string[]=[], bodies:any[]=[]; let turn=0;
  globalThis.fetch = (async (url:any, init:any={}) => {
    const u=String(url); const j=(o:any)=>new Response(JSON.stringify(o),{status:200});
    if (u.includes("/tags")) { tags.push(...JSON.parse(init.body).tags); return j({}); }
    if (u.includes("/notes")) { notes.push(JSON.parse(init.body).body); return j({}); }
    if (u.endsWith("/contacts/c1")) return j({contact:{firstName:"Bailey",tags:[],locationId:"l"}});
    if (u.includes("/conversations/search")) return j({conversations:[{id:"v"}]});
    if (u.includes("/conversations/v/messages")) return j({messages:{messages:[
      {direction:"outbound",body:"Hi",dateAdded:"1"},{direction:"inbound",body:"Id like someone to call me in 25 minutes please",dateAdded:"2"}]}});
    if (u.endsWith("/conversations/messages")) { sent.push(JSON.parse(init.body).message); return j({}); }
    if (u.includes("anthropic")) { bodies.push(JSON.parse(init.body)); return j(replies[turn++]); }
    throw new Error(u);
  }) as any;
  await handler({method:"POST",headers:{"x-webhook-secret":"s"},query:{},body:{contact_id:"c1"}} as any,res);
  return {sent, tags, notes, bodies};
}
const empty={stop_reason:"end_turn",content:[]};
// 1. blank once -> retry with stronger SYSTEM note (not text after tool results), tools still on
let r = await run([empty,{stop_reason:"end_turn",content:[{type:"text",text:"Yep, no worries! We'll get someone to give you a buzz in about 25 mins."}]}]);
assert.deepEqual(r.sent,["Yep, no worries! We'll get someone to give you a buzz in about 25 mins."]);
assert.match(r.bodies[1].system,/produced no SMS text/); assert.equal(r.bodies[1].tool_choice,undefined);
assert.equal(JSON.stringify(r.bodies[1].messages), JSON.stringify(r.bodies[0].messages)); // messages untouched
// 2. blank three times -> 3rd try has tools off; then safe fallback records a callback, no repeated question
r = await run([empty,empty,empty]);
assert.deepEqual(r.bodies[2].tool_choice,{type:"none"});
assert.deepEqual(r.sent,["No worries, we'll have someone from the team give you a buzz soon."]);
assert.ok(r.tags.includes("ai-callback")); assert.match(r.notes[0],/AI CALLBACK/);
console.log("empty-reply tests passed");
