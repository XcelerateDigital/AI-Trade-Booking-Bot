import type { VercelRequest, VercelResponse } from "@vercel/node";
import { findConversationId, getContact, getTranscript, sendSms, addTags, addNote } from "../lib/ghl.js";
import { generateReply, type Ctx } from "../lib/ai.js";

export const config = { maxDuration: 60 };

const HUMAN_TAGS = ["ai-stop", "ai-booked", "ai-handoff"];

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
    // A human has taken over, or the bot already finished: stay quiet.
    if (contact.tags?.some((t) => HUMAN_TAGS.includes(t.toLowerCase()))) {
      return res.status(200).json({ skipped: "human-or-finished tag" });
    }

    const conversationId = await findConversationId(contactId, locationId);
    if (!conversationId) return res.status(200).json({ skipped: "no conversation" });

    const transcript = await getTranscript(conversationId);
    const last = transcript[transcript.length - 1];
    // Duplicate webhook, or we've already answered the latest message.
    if (!last || last.direction !== "inbound") return res.status(200).json({ skipped: "nothing to answer" });

    // Runaway guard: cap how many replies the bot sends per lead.
    const botReplies = transcript.filter((m) => m.direction === "outbound").length;
    if (botReplies > 20) {
      await addTags(contactId, ["ai-stop"]);
      await addNote(contactId, "AI stopped after 20 messages without a booking. Needs a human.");
      return res.status(200).json({ skipped: "message cap" });
    }

    const ctx: Ctx = { contactId, locationId, firstName: contact.firstName };
    const reply = await generateReply(transcript, ctx);
    if (reply) await sendSms(contactId, reply);

    if (ctx.outcome === "booked") await addTags(contactId, ["ai-booked"]);
    if (ctx.outcome === "handoff") await addTags(contactId, ["ai-handoff"]);

    return res.status(200).json({ ok: true, outcome: ctx.outcome ?? "continuing" });
  } catch (e: any) {
    console.error("ghl-reply failed", e);
    // Fail safe: flag for a human rather than leaving the lead hanging in silence.
    try {
      await addTags(contactId, ["ai-handoff"]);
      await addNote(contactId, `AI error, needs a human: ${e.message}`);
    } catch {}
    return res.status(500).json({ error: "failed" });
  }
}
