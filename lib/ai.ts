import { buildSystemPrompt } from "./prompt.js";
import type { ChatMessage } from "./ghl.js";
import * as ghl from "./ghl.js";
import { defaultProfile, type Profile } from "./profile.js";
import { setLeadFields } from "./fields.js";

type Block = { type: string; [k: string]: any };
type Msg = { role: "user" | "assistant"; content: string | Block[] };

export interface Ctx {
  contactId: string;
  locationId: string;
  firstName?: string;
  /** The client's business profile (from their GHL Custom Values). */
  profile?: Profile;
  /** Set once the bot books, records a requested time, or the lead opts out, so the endpoint can tag the contact. */
  outcome?: "booked" | "requested" | "callback" | "opted_out";
}

const profileOf = (ctx: Ctx) => ctx.profile ?? defaultProfile();
const tzOf = (ctx: Ctx) => profileOf(ctx).timezone || "Australia/Sydney";
const calendarOf = (ctx: Ctx) => profileOf(ctx).calendarId;

/** GHL transcript -> Claude messages (alternating roles, first message is from the user). */
export function toClaudeMessages(transcript: ChatMessage[]): Msg[] {
  const out: Msg[] = [];
  for (const m of transcript) {
    const role = m.direction === "inbound" ? "user" : "assistant";
    const blocks: Block[] = [];
    if (m.body) blocks.push({ type: "text", text: m.body });
    // Photos only matter from the lead; Claude can't take images in assistant turns.
    if (role === "user") for (const url of m.attachments) blocks.push({ type: "image", source: { type: "url", url } });
    if (!blocks.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) (prev.content as Block[]).push(...blocks);
    else out.push({ role, content: blocks });
  }
  if (out[0]?.role === "assistant") {
    out.unshift({ role: "user", content: [{ type: "text", text: "[Lead submitted an enquiry through the website]" }] });
  }
  return out;
}

const MAX_IMAGE_BYTES = 4_500_000; // Claude's limit is 5MB per image
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/**
 * Claude can't fetch many photo hosts itself (robots.txt blocks, auth, etc.), so download
 * each photo here and send it inline as base64. If one can't be loaded, say so in text
 * rather than failing the whole reply.
 */
export async function inlineImages(messages: Msg[]): Promise<Msg[]> {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    m.content = await Promise.all(
      m.content.map(async (b): Promise<Block> => {
        if (b.type !== "image" || b.source?.type !== "url") return b;
        const note: Block = { type: "text", text: "[The lead sent a photo that could not be loaded. Ask them to describe it.]" };
        try {
          const r = await fetch(b.source.url);
          if (!r.ok) return note;
          const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
          const buf = Buffer.from(await r.arrayBuffer());
          if (!IMAGE_TYPES.includes(type) || buf.length > MAX_IMAGE_BYTES) return note;
          return { type: "image", source: { type: "base64", media_type: type, data: buf.toString("base64") } };
        } catch {
          return note;
        }
      }),
    );
  }
  return messages;
}

const tools = (canBook: boolean) => [
  {
    name: "save_job_details",
    description: "Save a summary of the job to the lead's GHL record. Call once the problem is understood; call again if details change.",
    input_schema: {
      type: "object",
      properties: {
        trade: { type: "string", description: "plumbing, electrical, carpentry, general, etc." },
        problem: { type: "string", description: "One-line description of the issue" },
        urgency: { type: "string", enum: ["emergency", "urgent", "this_week", "flexible", "unknown"] },
        location: { type: "string", description: "Suburb or address if known" },
        photo_notes: { type: "string", description: "What you can see in any photos they sent" },
        preferred_time: { type: "string", description: "Day/time the lead wants the team to call or attend, in their words" },
      },
      required: ["trade", "problem"],
    },
  },
  ...(canBook
    ? [
        {
          name: "get_available_slots",
          description: "Get the next available appointment slots from the calendar.",
          input_schema: { type: "object", properties: { days_ahead: { type: "integer", default: 7 } } },
        },
        {
          name: "book_appointment",
          description: "Book the slot the lead chose. start_time must be exactly one of the ISO strings returned by get_available_slots.",
          input_schema: {
            type: "object",
            properties: {
              start_time: { type: "string" },
              summary: { type: "string", description: "Job summary for the team" },
            },
            required: ["start_time", "summary"],
          },
        },
      ]
    : []),
  {
    name: "request_booking",
    description: "Lock in the visit at the day/time the lead asked for, when it can't be booked straight into the calendar. Records it in GHL for the team.",
    input_schema: {
      type: "object",
      properties: {
        requested_time: { type: "string", description: "The day and time the lead wants, in their words plus your best exact reading (e.g. 'Thu 6 Nov, after 3pm')" },
        summary: { type: "string", description: "Job summary for the team, including suburb and urgency" },
      },
      required: ["requested_time", "summary"],
    },
  },
  {
    name: "request_callback",
    description: "The lead chose a phone call from the team instead of booking a visit. Records the callback time in GHL for the team.",
    input_schema: {
      type: "object",
      properties: {
        callback_time: { type: "string", description: "When to call, in their words plus your best exact reading (e.g. 'ASAP', 'Thu 6 Nov after 3pm')" },
        summary: { type: "string", description: "Job summary for the team, including suburb and urgency" },
      },
      required: ["callback_time", "summary"],
    },
  },
  {
    name: "opt_out",
    description: "ONLY when the lead says STOP/unsubscribe or asks not to be messaged. Stops all further messages to them.",
    input_schema: { type: "object", properties: {} },
  },
];

async function runTool(name: string, input: any, ctx: Ctx): Promise<string> {
  try {
    switch (name) {
      case "save_job_details": {
        const note = [
          "AI lead qualification",
          `Trade: ${input.trade}`,
          `Problem: ${input.problem}`,
          input.urgency && `Urgency: ${input.urgency}`,
          input.location && `Location: ${input.location}`,
          input.photo_notes && `Photos: ${input.photo_notes}`,
          input.preferred_time && `Preferred time: ${input.preferred_time}`,
        ]
          .filter(Boolean)
          .join("\n");
        await ghl.addNote(ctx.contactId, note);
        const emergency = input.urgency === "emergency";
        await ghl.addTags(ctx.contactId, [
          "ai-qualified",
          ...(input.trade ? [`trade-${String(input.trade).toLowerCase().replace(/\s+/g, "-")}`] : []),
          ...(emergency ? ["ai-emergency"] : []),
        ]);
        await setLeadFields(ctx.locationId, ctx.contactId, {
          "Service Required": input.trade ? `${input.trade}: ${input.problem}` : input.problem,
          "Customer Suburb": input.location,
          Urgency: input.urgency,
          "Job Summary": [input.problem, input.photo_notes && `Photos: ${input.photo_notes}`].filter(Boolean).join(". "),
          "Preferred Time": input.preferred_time,
        });
        return "Saved. Now write your SMS reply to the lead: the next question or step.";
      }
      case "get_available_slots": {
        const slots = await ghl.getFreeSlots(calendarOf(ctx), Math.min(input.days_ahead || 7, 14), tzOf(ctx));
        if (!slots.length) return "No slots available in that window. Try days_ahead 14; if still none, ask the lead what day and time suits and use request_booking.";
        const pretty = slots.map((s) => ({
          iso: s,
          human: new Date(s).toLocaleString("en-AU", { timeZone: tzOf(ctx), weekday: "long", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }),
        }));
        return JSON.stringify(pretty);
      }
      case "book_appointment": {
        await ghl.bookAppointment({
          calendarId: calendarOf(ctx),
          locationId: ctx.locationId,
          contactId: ctx.contactId,
          startTime: input.start_time,
          title: `Job: ${String(input.summary).slice(0, 80)}`,
          notes: input.summary,
        });
        ctx.outcome = "booked";
        await setLeadFields(ctx.locationId, ctx.contactId, {
          "Preferred Time": new Date(input.start_time).toLocaleString("en-AU", { timeZone: tzOf(ctx), dateStyle: "medium", timeStyle: "short" }),
        });
        return "Booked successfully. Confirm the day and time to the lead in one short message.";
      }
      case "request_booking": {
        await ghl.addNote(ctx.contactId, `AI BOOKING - visit requested for: ${input.requested_time}\n${input.summary}`);
        ctx.outcome = "requested";
        await setLeadFields(ctx.locationId, ctx.contactId, { "Preferred Time": input.requested_time });
        return "Recorded. Confirm to the lead in one short message that they're booked in and someone from the team will come out at that time.";
      }
      case "request_callback": {
        await ghl.addNote(ctx.contactId, `AI CALLBACK - call the lead: ${input.callback_time}\n${input.summary}`);
        ctx.outcome = "callback";
        await setLeadFields(ctx.locationId, ctx.contactId, { "Callback Time": input.callback_time });
        return "Recorded. Now reply to the lead with one short, casual confirmation, e.g. \"Yep, no worries! We'll get someone from the team to give you a buzz in about 30 mins.\" (use their time, or \"soon\" if they didn't give one).";
      }
      case "opt_out": {
        await ghl.addTags(ctx.contactId, ["ai-stop"]);
        ctx.outcome = "opted_out";
        return "Opted out. Reply with one short confirmation and nothing else.";
      }
      default:
        return `Unknown tool ${name}`;
    }
  } catch (e: any) {
    console.error(`tool ${name} failed`, e);
    return `Tool error: ${e.message}. Do not retry more than once; if it keeps failing, ask the lead what day and time suits and use request_booking.`;
  }
}

export async function generateReply(transcript: ChatMessage[], ctx: Ctx): Promise<string> {
  const profile = profileOf(ctx);
  // Booking straight into the calendar needs a calendar, and the client must offer bookings.
  const canBook = !!profile.calendarId && profile.options !== "callback";
  const system = buildSystemPrompt({
    firstName: ctx.firstName,
    canBook,
    profile,
    nowLocal: new Date().toLocaleString("en-AU", { timeZone: tzOf(ctx), dateStyle: "full", timeStyle: "short" }),
  });
  const base: Msg[] = await inlineImages(toClaudeMessages(transcript));
  const messages: Msg[] = [...base];
  // Claude often writes the SMS in the same turn as a tool call, then says nothing after the
  // tool result. Keep every bit of text so the reply is never silently dropped.
  const said: string[] = [];
  const done: string[] = []; // tools already run this turn, for the clean retry
  const blanks: string[] = []; // stop reasons of blank replies, for diagnosis
  // Claude occasionally returns a blank reply, almost always right after a tool result.
  // Retry 1: same conversation, stronger instruction in the system prompt.
  // Retry 2: a clean request with just the SMS conversation (no tool history), tools still
  //          available so a callback or booking can still be recorded.
  let retries = 0;
  let clean = false;
  const RETRY_NOTE =
    "\n\nIMPORTANT: your previous attempt produced no SMS text. Your reply MUST contain the SMS to send to the lead. Use any tools you still need, then write the message. Use every answer they've already given and don't repeat a question.";

  for (let i = 0; i < 8; i++) {
    if (retries >= 2 && !clean) {
      clean = true;
      messages.length = 0;
      messages.push(...base);
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || "claude-sonnet-5-5",
        max_tokens: 500,
        system: !retries
          ? system
          : clean
            ? `${system}\n\nIMPORTANT: write the next SMS to the lead now.${done.length ? ` Already done this turn (don't repeat): ${done.join("; ")}.` : ""} Use every answer they've already given and don't repeat a question. Output only the SMS.`
            : system + RETRY_NOTE,
        tools: tools(canBook),
        messages,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    const text = (data.content as Block[]).filter((b) => b.type === "text").map((b) => b.text).join("").trim();

    if (text) said.push(text);

    if (data.stop_reason !== "tool_use") {
      if (text) return await ensureRecorded(text, ctx, transcript);
      if (said.length) return await ensureRecorded(said[said.length - 1], ctx, transcript);
      blanks.push(`${data.stop_reason}:${(data.content as Block[]).map((b) => b.type).join(",") || "empty"}`);
      console.warn("empty reply from Claude", { blanks, retries, outcome: ctx.outcome, done });
      if (retries < 2) {
        retries++;
        continue;
      }
      // Last resort: a sensible next step that never repeats the previous message.
      await ghl.addNote(ctx.contactId, `AI note: the AI gave blank replies (${blanks.join(" | ")}); a backup message was sent. Check this conversation.`).catch(() => {});
      return fallbackMessage(ctx, transcript);
    }

    messages.push({ role: "assistant", content: data.content });
    const results: Block[] = [];
    for (const b of data.content as Block[]) {
      if (b.type === "tool_use") {
        results.push({ type: "tool_result", tool_use_id: b.id, content: await runTool(b.name, b.input, ctx) });
        done.push(b.name === "save_job_details" ? "saved the job details" : b.name.replace(/_/g, " "));
      }
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("Tool loop did not finish");
}

/** Backup reply when the AI can't produce one: move the lead towards a callback or booking. */
export function fallbackMessage(ctx: Ctx, transcript: ChatMessage[]): string {
  if (ctx.outcome === "booked" || ctx.outcome === "requested") return "You're all booked in. Someone from the team will see you then.";
  if (ctx.outcome === "callback") return "All sorted, someone from the team will give you a buzz then.";
  if (ctx.outcome === "opted_out") return "No worries, you won't get any more messages from us.";
  const options = profileOf(ctx).options;
  const ask =
    options === "callback"
      ? "Thanks for that. When suits for someone from the team to give you a call?"
      : options === "booking"
        ? "Thanks for that. What day and time suits for someone from the team to come out?"
        : "Thanks for that. Would you like to book a time for someone from the team to come out, or would you prefer a call back?";
  const lastSent = [...transcript].reverse().find((m) => m.direction === "outbound")?.body?.trim();
  if (lastSent !== ask) return ask;
  return options === "callback"
    ? "Sorry about that. What time works best for a quick call?"
    : "Sorry about that. What day and time suits you best?";
}

/**
 * Safety net: if the reply promises a call but no callback was recorded, record one, so the
 * tradie is always alerted when the lead has been told someone will ring.
 */
async function ensureRecorded(reply: string, ctx: Ctx, transcript: ChatMessage[]): Promise<string> {
  if (ctx.outcome) return reply;
  const promisesCall = /\b(give you a (buzz|call|ring)|call you|ring you|be in touch by phone)\b/i.test(reply);
  if (!promisesCall) return reply;
  const lastIn = [...transcript].reverse().find((m) => m.direction === "inbound")?.body ?? "";
  console.warn("reply promised a call without recording it; recording now");
  await runTool("request_callback", { callback_time: lastIn.slice(0, 120) || "ASAP", summary: `Lead was told: "${reply}"` }, ctx);
  return reply;
}
