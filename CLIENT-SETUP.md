# Adding a new client

One bot serves every client. Each client's answers live in **their own GHL sub-account** as Custom Values, and the bot reads them on every message. Edit an answer in GHL (Settings > Custom Values) and the bot uses it on the next text, with no redeploy.

## 1. Collect the answers

Copy `clients/_template.json` to `clients/<client-name>.json` and fill in `profile`. The questions are listed in the same file. Leave anything unknown blank; the bot only uses what's filled in.

| Custom Value | What it controls |
|---|---|
| AI Business Name | The name the bot uses |
| AI Trade | e.g. `plumbing`, `painting`, `electrical` |
| AI Services / AI Services Not Offered | What the bot accepts, and what it politely declines (offering a quick call instead) |
| AI Service Area / AI Outside Area | Where they work, and what to say to leads outside it |
| AI Hours / AI After Hours | Callbacks requested outside hours are moved to the next business day unless After Hours says otherwise |
| AI Pricing | The ONLY prices the bot may mention. Blank = never mentions prices |
| AI Job Length | Typical visit length and notice needed |
| AI Qualifying Questions | Extra questions the bot asks (e.g. "owner or renter, how many rooms") |
| AI Emergencies | Extra emergency rules |
| AI Tone | Casual/formal, words to use or avoid |
| AI Extra Info | Licence, guarantees, payment methods, FAQs. Used only to answer questions |
| AI Options | `both` (default), `callback` only, or `booking` only |
| AI Calendar ID | GHL calendar to book into (Settings > Calendars, copy icon next to the ID) |
| AI Timezone | e.g. `Australia/Brisbane` (Queensland has no daylight saving) |

## 2. Create the client's GHL token

In the client's sub-account: **Settings > Private Integrations > Create**, with these scopes:
View/Edit Contacts, View/Edit Conversations, View/Edit Conversation Messages, View Calendars, View/Edit Calendar Events, **View/Edit Custom Values**, **View/Edit Custom Fields**.

## 3. Load the answers into their GHL

```
GHL_TOKEN=pit-xxxx npx tsx scripts/setup-client.ts clients/<client-name>.json           # preview
GHL_TOKEN=pit-xxxx npx tsx scripts/setup-client.ts clients/<client-name>.json --apply   # do it
```

This creates/updates the "AI ..." Custom Values and the lead-qualifier contact fields
(Service Required, Customer Suburb, Urgency, Job Summary, Preferred Time, Callback Time). It never deletes anything.
(Or type the Custom Values in by hand: Settings > Custom Values, using the exact names above.)

## 4. Give the bot the client's token

In Vercel > Environment Variables, `GHL_TOKENS` is a JSON list of every client's token, keyed by GHL location id:

```
{"ufcbt6hoEfh82RyMe72z":"pit-aaaa","AbCdEf123456":"pit-bbbb"}
```

Add the new client, save, then redeploy. (`GHL_API_TOKEN` is still used for any location not listed.)

## 5. GHL workflows in the client's account

- **Opener**: Pipeline stage = New Lead → Send SMS (first text, ending `– {{location.name}} (reply STOP to opt out)`).
- **AI Lead Replies**: Customer Replied (SMS), **filtered** to new leads (e.g. pipeline stage or tag) → Webhook POST to `https://<bot>.vercel.app/api/ghl-reply?secret=<WEBHOOK_SECRET>`.
- **Alerts**: tag added `ai-callback` / `ai-booked` / `ai-booking-requested` / `ai-emergency` → Internal Notification (SMS) to the tradie.

## 6. Test

Text in as a customer: ask for a callback once and a booking once. Check the contact gets the tags, a note, and the qualifier fields filled in.
