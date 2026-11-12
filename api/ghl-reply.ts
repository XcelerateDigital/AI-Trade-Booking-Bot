import type { VercelRequest, VercelResponse } from "@vercel/node";
import { findConversationId, getContact, getTranscript, sendSms, addTags, addNote, withLocation } from "../lib/ghl.js";
import { generateReply, type Ctx } from "../lib/ai.js";
import { loadProfile } from "../lib/profile.js";

export const config = { maxDuration: 60 };

// Only these stop the bot: the lead opted out, or you added ai-stop to take over yourself.
const STOP_TAGS = ["ai-stop"];

/**
 * GHL workflow: trigger "Customer Replied" (SMS) -> action "Webhook" (POST) to this URL
 * with header x-webhook-secret. Payload only needs the contact id; the rest comes from the API.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  // Secret can be sent as a header or as ?secret= on the URL (some GHL accounts have no header box).
  const given = req.headers["x-webhook-secret"] ?? req.query.secret;
  if (!process.env.WEBHOOK_SECRET || given !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const body = req.body || {};
  const contactId: string | undefined = body.contact_id || body.contactId || body.contact?.id;
  if (!contactId) return res.status(400).json({ error: "missing contact_id" });

  // Which client (GHL sub-account) this is for. GHL's webhook payload includes location.id;
  // ?location= on the URL also works. It picks the client's own GHL token.
  const payloadLocation: string | undefined = body.location?.id || body.locationId || body.location_id || (req.query.location as string);
  return withLocation(payloadLocation, () => handle(req, res, body, contactId, payloadLocation));
}

const DEBOUNCE_MS = Number(process.env.REPLY_DELAY_MS ?? 8000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const counts = (t: { direction: string }[]) => ({
  inbound: t.filter((m) => m.direction === "inbound").length,
  outbound: t.filter((m) => m.direction === "outbound").length,
});

async function handle(req: VercelRequest, res: VercelResponse, body: any, contactId: string, payloadLocation?: string) {
  const started = Date.now();
  try {
    const contact = await getContact(contactId);
    const locationId = contact.locationId || payloadLocation;
    if (!locationId) return res.status(400).json({ error: "could not work out location" });
    // Lead opted out, or a human has taken over: stay quiet.
    if (contact.tags?.some((t) => STOP_TAGS.includes(t.toLowerCase()))) {
      return res.status(200).json({ skipped: "stop tag" });
    }

    const conversationId = await findConversationId(contactId, locationId);
    if (!conversationId) return res.status(200).json({ skipped: "no conversation" });

    let transcript = await getTranscript(conversationId);
    const last = transcript[transcript.length - 1];
    // Duplicate webhook, or we've already answered the latest message.
    if (!last || last.direction !== "inbound") return res.status(200).json({ skipped: "nothing to answer" });

    // Double-texters: people often send two or three texts in a row ("toilet's blocked" ...
    // "it's overflowing"). Wait a few seconds; if another text arrives, this webhook stands down
    // and the newer one answers everything in one reply.
    const seen = counts(transcript);
    await sleep(DEBOUNCE_MS);
    transcript = await getTranscript(conversationId);
    const now = counts(transcript);
    if (now.inbound > seen.inbound) return res.status(200).json({ skipped: "newer message will be answered" });
    if (now.outbound > seen.outbound) return res.status(200).json({ skipped: "already answered" });

    // Runaway guard: cap how many replies the bot sends per lead.
    const botReplies = transcript.filter((m) => m.direction === "outbound").length;
    if (botReplies > 40) {
      await addTags(contactId, ["ai-stop"]);
      await addNote(contactId, "AI stopped after 40 messages (runaway guard). Check this conversation.");
      return res.status(200).json({ skipped: "message cap" });
    }

    const profile = await loadProfile(locationId);
    // Leave a safety margin under the 60s server limit to send the SMS and tag the contact.
    const ctx: Ctx = { contactId, locationId, firstName: contact.firstName, profile, deadline: started + 48_000 };
    let reply = await generateReply(transcript, ctx);
    // Before sending, check nothing changed while the AI was thinking:
    // - someone else (a duplicate webhook or a person) already replied -> don't double up
    // - the lead sent another text -> write one reply that covers it too
    for (let i = 0; i < 2 && reply && Date.now() < started + 30_000; i++) {
      const latest = await getTranscript(conversationId);
      const c = counts(latest);
      if (c.outbound > now.outbound) return res.status(200).json({ skipped: "already answered", outcome: ctx.outcome ?? "continuing" });
      if (c.inbound === counts(transcript).inbound) break;
      transcript = latest;
      reply = await generateReply(transcript, ctx);
    }
    if (reply) await sendSms(contactId, reply);
    console.log("ghl-reply", { business: profile.businessName, contactId, sent: !!reply, outcome: ctx.outcome ?? "continuing" });

    // (Outcome tags such as ai-booked / ai-callback are added the moment each action happens,
    //  so a lead who asks for a booking AND a callback triggers both alerts.)

    return res.status(200).json({ ok: true, outcome: ctx.outcome ?? "continuing" });
  } catch (e: any) {
    console.error("ghl-reply failed", e);
    // Don't go silent: log it, and nudge the lead so the next reply retries the booking.
    try {
      await addNote(contactId, `AI error (bot will retry on next message): ${e.message}`);
      await sendSms(contactId, "Sorry, small hiccup on our end. Could you send that through again?");
    } catch {}
    return res.status(500).json({ error: "failed" });
  }
}
