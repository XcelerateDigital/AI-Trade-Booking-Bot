import { buildSystemPrompt } from "./prompt.js";
import type { ChatMessage } from "./ghl.js";
import * as ghl from "./ghl.js";

type Block = { type: string; [k: string]: any };
type Msg = { role: "user" | "assistant"; content: string | Block[] };

export interface Ctx {
  contactId: string;
  locationId: string;
  firstName?: string;
  /** Set to true once the bot has handed off or booked, so the endpoint can tag the contact. */
  outcome?: "booked" | "handoff";
}

const TZ = () => process.env.TIMEZONE || "Australia/Sydney";

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
              summary: { type: "string", description: "Job summary for the tradie" },
            },
            required: ["start_time", "summary"],
          },
        },
      ]
    : []),
  {
    name: "handoff_to_human",
    description: "Flag the lead for a human to take over (emergency, angry, wants a person, out of scope, or booking not possible).",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        urgency: { type: "string", enum: ["emergency", "normal"] },
      },
      required: ["reason"],
    },
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
        await ghl.addTags(ctx.contactId, ["ai-qualified", ...(input.trade ? [`trade-${String(input.trade).toLowerCase()}`] : [])]);
        return "Saved.";
      }
      case "get_available_slots": {
        const cal = process.env.GHL_CALENDAR_ID!;
        const slots = await ghl.getFreeSlots(cal, Math.min(input.days_ahead || 7, 14), TZ());
        if (!slots.length) return "No slots available in that window. Offer to have the team call, and use handoff_to_human.";
        const pretty = slots.map((s) => ({
          iso: s,
          human: new Date(s).toLocaleString("en-AU", { timeZone: TZ(), weekday: "long", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }),
        }));
        return JSON.stringify(pretty);
      }
      case "book_appointment": {
        await ghl.bookAppointment({
          calendarId: process.env.GHL_CALENDAR_ID!,
          locationId: ctx.locationId,
          contactId: ctx.contactId,
          startTime: input.start_time,
          title: `Job: ${String(input.summary).slice(0, 80)}`,
          notes: input.summary,
        });
        ctx.outcome = "booked";
        return "Booked successfully. Confirm the day and time to the lead in one short message.";
      }
      case "handoff_to_human": {
        await ghl.addNote(ctx.contactId, `AI handoff (${input.urgency || "normal"}): ${input.reason}`);
        ctx.outcome = "handoff";
        return "Flagged for the team. Send the lead a short, reassuring message about what happens next.";
      }
      default:
        return `Unknown tool ${name}`;
    }
  } catch (e: any) {
    console.error(`tool ${name} failed`, e);
    return `Tool error: ${e.message}. Do not retry more than once; if it keeps failing, use handoff_to_human.`;
  }
}

export async function generateReply(transcript: ChatMessage[], ctx: Ctx): Promise<string> {
  const canBook = !!process.env.GHL_CALENDAR_ID;
  const system = buildSystemPrompt({
    firstName: ctx.firstName,
    canBook,
    nowLocal: new Date().toLocaleString("en-AU", { timeZone: TZ(), dateStyle: "full", timeStyle: "short" }),
  });
  const messages: Msg[] = await inlineImages(toClaudeMessages(transcript));

  for (let i = 0; i < 6; i++) {
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
        system,
        tools: tools(canBook),
        messages,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    const text = (data.content as Block[]).filter((b) => b.type === "text").map((b) => b.text).join("").trim();

    if (data.stop_reason !== "tool_use") return text;

    messages.push({ role: "assistant", content: data.content });
    const results: Block[] = [];
    for (const b of data.content as Block[]) {
      if (b.type === "tool_use") results.push({ type: "tool_result", tool_use_id: b.id, content: await runTool(b.name, b.input, ctx) });
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("Tool loop did not finish");
}
