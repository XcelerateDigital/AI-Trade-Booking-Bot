import type { VercelRequest, VercelResponse } from "@vercel/node";
import { findConversationId, getContact, getTranscript, sendSms, addTags, addNote } from "../lib/ghl.js";
import { generateReply, type Ctx } from "../lib/ai.js";

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

  try {
    const contact = await getContact(contactId);
    const locationId = contact.locationId || body.location?.id || body.locationId;
    if (!locationId) return res.status(400).json({ error: "could not work out location" });
    // Lead opted out, or a human has taken over: stay quiet.
    if (contact.tags?.some((t) => STOP_TAGS.includes(t.toLowerCase()))) {
      return res.status(200).json({ skipped: "stop tag" });
    }

    const conversationId = await findConversationId(contactId, locationId);
    if (!conversationId) return res.status(200).json({ skipped: "no conversation" });

    const transcript = await getTranscript(conversationId);
    const last = transcript[transcript.length - 1];
    // Duplicate webhook, or we've already answered the latest message.
    if (!last || last.direction !== "inbound") return res.status(200).json({ skipped: "nothing to answer" });

    // Runaway guard: cap how many replies the bot sends per lead.
    const botReplies = transcript.filter((m) => m.direction === "outbound").length;
    if (botReplies > 40) {
      await addTags(contactId, ["ai-stop"]);
      await addNote(contactId, "AI stopped after 40 messages (runaway guard). Check this conversation.");
      return res.status(200).json({ skipped: "message cap" });
    }

    const ctx: Ctx = { contactId, locationId, firstName: contact.firstName };
    const reply = await generateReply(transcript, ctx);
    if (reply) await sendSms(contactId, reply);
    console.log("ghl-reply", { contactId, sent: !!reply, outcome: ctx.outcome ?? "continuing" });

    if (ctx.outcome === "booked") await addTags(contactId, ["ai-booked"]);
    if (ctx.outcome === "requested") await addTags(contactId, ["ai-booking-requested"]);
    if (ctx.outcome === "callback") await addTags(contactId, ["ai-callback"]);

    return res.status(200).json({ ok: true, outcome: ctx.outcome ?? "continuing" });
  } catch (e: any) {
    console.error("ghl-reply failed", e);
    // Don't go silent: log it, and nudge the lead so the next reply retries the booking.
    try {
      await addNote(contactId, `AI error (bot will retry on next message): ${e.message}`);
      await sendSms(contactId, "Sorry, small hiccup on our end. Would you like someone from the team to give you a call, or shall I book a time for them to come out?");
    } catch {}
    return res.status(500).json({ error: "failed" });
  }
}
