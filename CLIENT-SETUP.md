# Adding a new client

One bot serves every client. Each client's answers live in **their own GHL sub-account** as Custom Values, and the bot reads them on every message. Edit an answer in GHL (Settings > Custom Values) and the bot uses it on the next text, with no redeploy.

## 1. Collect the answers

Send the tradie the **AI Booking Bot – Client Questionnaire** doc. Each answer maps to one GHL Custom Value:

| Q | Custom Value | Used for |
|---|---|---|
| 1 | AI Business Name | The name the bot uses |
| 2 | AI Trade | e.g. `plumbing`, `painting` |
| 3 | AI Services | What the bot accepts |
| 4 | AI Services Not Offered | Politely declined (jobs clearly in another trade are declined too, once AI Trade is set) ("sorry, we can't help with that one"), no call or booking offered |
| 5 | AI Service Area | Where they work |
| 6 | AI Outside Area | What to say to leads outside it |
| 7 | AI Hours | Business hours |
| 8 | AI After Hours | After-hours / emergency work and charges |
| 9 | AI After Hours Callbacks | What to say when a call is wanted outside hours |
| 10 | AI Timezone | e.g. `Australia/Brisbane` (no daylight saving) |
| 11 | AI Pricing | The ONLY prices the bot may mention; blank = none |
| 12 | AI Job Length | Typical visit length |
| 13 | AI Notice Needed | The bot won't book sooner than this |
| 14 | AI Qualifying Questions | Extra questions the bot asks |
| 15 | AI Options | `both`, `callback` or `booking` |
| 16 | (setup) | Google account to connect the calendar → **AI Calendar ID** |
| 17 | AI Alert Mobile | Alert workflows only: never shown to the AI |
| 18 | AI Emergencies | What counts as an emergency |
| 19 | AI Emergency Contacts | Alert workflows only: never shown to the AI |
| 20 | AI Tone | Casual/formal, words to use or avoid |
| 21–24 | AI Licence, AI Guarantees, AI Payment Methods, AI FAQs | Used only to answer customers' questions |

Paste the answers into `clients/<client-name>.json` (copy `clients/_template.json`; it lists the Q numbers), or paste the doc into the chat and Claude will do it.

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
- **Alerts**: tag added `ai-callback` / `ai-booked` / `ai-booking-requested` / `ai-emergency` → Internal Notification (SMS) to the tradie. For the number, use the custom value `{{custom_values.ai_alert_mobile}}` (pick it from the tag icon) so it follows Q17.

## 6. Test

Text in as a customer: ask for a callback once and a booking once. Check the contact gets the tags, a note, and the qualifier fields filled in.
