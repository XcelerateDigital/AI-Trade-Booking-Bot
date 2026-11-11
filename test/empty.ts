import assert from "node:assert/strict";
process.env.WEBHOOK_SECRET="s"; process.env.GHL_API_TOKEN="t"; process.env.ANTHROPIC_API_KEY="k";
const handler = (await import("../api/ghl-reply")).default;
const res:any={status:()=>res,json:()=>res,end:()=>res};
async function run(replies:any[], leadText = "Id like someone to call me in 25 minutes please", lastOut = "Hi") {
  const sent:string[]=[], tags:any[]=[], notes:string[]=[], bodies:any[]=[]; let turn=0;
  globalThis.fetch = (async (url:any, init:any={}) => {
    const u=String(url); const j=(o:any)=>new Response(JSON.stringify(o),{status:200});
    if (u.includes("/tags")) { tags.push(...JSON.parse(init.body).tags); return j({}); }
    if (u.includes("/notes")) { notes.push(JSON.parse(init.body).body); return j({}); }
    if (u.endsWith("/contacts/c1")) return j({contact:{firstName:"Bailey",tags:[],locationId:"l"}});
    if (u.includes("/conversations/search")) return j({conversations:[{id:"v"}]});
    if (u.includes("/conversations/v/messages")) return j({messages:{messages:[
      {direction:"outbound",body:lastOut,dateAdded:"1"},{direction:"inbound",body:leadText,dateAdded:"2"}]}});
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
// 2. blank three times -> 3rd try is a clean request (plain conversation, tools still on);
//    backup follows what the lead asked: here a call, so record it and confirm (no re-asking)
r = await run([empty,empty,empty]);
assert.ok(r.bodies[2].tools, "clean retry keeps tools so it can still record a callback");
assert.equal(JSON.stringify(r.bodies[2].messages), JSON.stringify(r.bodies[0].messages));
assert.deepEqual(r.sent,["No worries, we'll get someone from the team to give you a buzz then."]);
assert.ok(r.tags.includes("ai-callback"));
assert.ok(r.notes.some((n) => /blank replies/.test(n)));
// 2b. backup when the lead hasn't chosen yet -> offers booking or call back
r = await run([empty,empty,empty], "It's leaking under the sink");
assert.deepEqual(r.sent,["Thanks for that. Would you like to book a time for someone from the team to come out, or would you prefer a call back?"]);
assert.ok(!r.tags.includes("ai-callback"));
// 2c. ...and never repeats that question if it was just sent
r = await run([empty,empty,empty], "ok", "Thanks for that. Would you like to book a time for someone from the team to come out, or would you prefer a call back?");
assert.deepEqual(r.sent,["Sorry about that, I missed that one. Could you send it through again?"]);
// 2d. lead asked for a visit -> asks for a time, not the choice
r = await run([empty,empty,empty], "Can someone come out this afternoon?");
assert.deepEqual(r.sent,["No worries. What day and time suits best for someone from the team to come out?"]);
// 3. blank after a tool call -> the clean retry (tools on, no tool history) records the callback
r = await run([
  {stop_reason:"tool_use",content:[{type:"tool_use",id:"t",name:"save_job_details",input:{trade:"plumbing",problem:"leaky sink",urgency:"tomorrow"}}]},
  empty, empty,
  {stop_reason:"tool_use",content:[{type:"tool_use",id:"c",name:"request_callback",input:{callback_time:"9am tomorrow",summary:"leaky sink"}}]},
  {stop_reason:"end_turn",content:[{type:"text",text:"Yep, no worries! Someone will give you a buzz around 9am tomorrow."}]}]);
assert.deepEqual(r.sent,["Yep, no worries! Someone will give you a buzz around 9am tomorrow."]);
assert.match(r.bodies[3].system, /Already done this turn \(don't repeat\): saved the job details/);
assert.equal(JSON.stringify(r.bodies[3].messages), JSON.stringify(r.bodies[0].messages));
assert.ok(r.tags.includes("ai-callback"));
// 4. reply promises a call but the AI forgot the tool -> safety net records it
r = await run([{stop_reason:"end_turn",content:[{type:"text",text:"No worries! Someone from the team will give you a buzz around 9am tomorrow."}]}]);
assert.ok(r.tags.includes("ai-callback"), "callback recorded by the safety net");
assert.match(r.notes.join("\n"), /AI CALLBACK/);
// 5. a normal question doesn't trigger it
r = await run([{stop_reason:"end_turn",content:[{type:"text",text:"What suburb are you in?"}]}]);
assert.equal(r.bodies[0].max_tokens >= 2000, true, "room for thinking + reply");
assert.ok(!r.tags.includes("ai-callback"));
console.log("empty-reply tests passed");

// photo type is read from the file, not the host's label
const { sniffImageType } = await import("../lib/ai");
assert.equal(sniffImageType(Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0,0,0,0,0])), "image/jpeg");
assert.equal(sniffImageType(Buffer.from("\x89PNG\r\n\x1a\n0000", "latin1")), "image/png");
assert.equal(sniffImageType(Buffer.from("ftypheic00000000")), undefined);
console.log("photo type tests passed");
