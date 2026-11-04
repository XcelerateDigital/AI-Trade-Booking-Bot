# START HERE: Set up your AI lead-reply bot

**What it does:** when a lead replies to your first text in GoHighLevel (GHL), an AI (Claude) reads the conversation, works out the problem, asks for photos, how urgent it is and the suburb, then asks whether they'd like a callback from the plumber or a booked visit, and locks in whichever they pick. Every conversation ends in a callback time (tag `ai-callback`) or a booking. With a calendar connected (`GHL_CALENDAR_ID`) it offers real free slots and books them; without one it records the lead's requested time as a note and tags the contact `ai-booking-requested`.

**You do NOT need to code.** Set aside about 30 minutes. You need 3 accounts: GitHub (you're here), Anthropic, and Vercel (free), plus your GHL login.

You will collect **4 values**. Keep a notes file open and paste them in as you go:

| # | Value | Where it comes from |
|---|-------|---------------------|
| 1 | `ANTHROPIC_API_KEY` | Step 1 |
| 2 | `GHL_API_TOKEN` | Step 2 |
| 3 | `WEBHOOK_SECRET` | Step 3 (you make it up) |
| 4 | `BUSINESS_NAME` | Your business name, e.g. `Smith Home Maintenance` |

---

## Step 1: Get your Claude (Anthropic) key

1. Go to **console.anthropic.com** and sign up / log in.
2. Add a payment method: **Settings > Billing**, add about $10 of credit. Each lead conversation costs a few cents at most.
3. Go to **Settings > API Keys > Create Key**. Name it `lead-bot`.
4. **Copy the key now** (starts with `sk-ant-`). You can't see it again. Save it as value **#1**.

## Step 2: Get your GoHighLevel key

1. Log into GHL and switch to the **sub-account** you use for your leads.
2. Go to **Settings > Private Integrations** (scroll the left menu; if you can't see it: Settings > Labs, or Settings > Business Profile, and switch on "Private Integrations").
3. Click **Create new Integration**. Name: `AI lead bot`.
4. Tick these permissions (scopes):
   - **View Contacts** and **Edit Contacts**
   - **View Conversations** and **Edit Conversations**
   - **View Conversation Messages** and **Edit Conversation Messages**
5. Create it and **copy the token** (starts with `pit-`). Save it as value **#2**.

## Step 3: Make up a webhook password

Invent a long random password, e.g. `kj83hd-92ndPq-77xLmz-4421`. No spaces. Save it as value **#3**. It stops strangers from triggering your bot.

## Step 4: Put the bot online (Vercel, free)

1. Go to **vercel.com** and sign up with GitHub.
2. Click **Add New > Project**, find **AI-Trade-Booking-Bot** in the list and click **Import**. (If it isn't listed, click "Adjust GitHub App permissions" and allow access to the repo.)
3. Before clicking Deploy, open **Environment Variables** and add these four, one at a time (Name, then Value, then Add):
   - `ANTHROPIC_API_KEY` = value #1
   - `GHL_API_TOKEN` = value #2
   - `WEBHOOK_SECRET` = value #3
   - `BUSINESS_NAME` = your business name
4. Click **Deploy**. Wait about a minute.
5. When it finishes, copy your site address from the top of the page (like `ai-trade-booking-bot.vercel.app`).
6. Your bot's address is that, plus `/api/ghl-reply?secret=` plus your password from #3:

   ```
   https://ai-trade-booking-bot.vercel.app/api/ghl-reply?secret=kj83hd-92ndPq-77xLmz-4421
   ```

   Save this as your **bot address**. If you change an environment variable later, go to Deployments > the latest one > Redeploy.

## Step 5: Connect GHL to the bot

1. In GHL go to **Automation > Workflows > Create Workflow > Start from scratch**. Name it `AI lead replies`.
2. **Add Trigger: Customer Replied.**
   - Set the reply channel to **SMS**.
   - Add a filter so it only fires for new enquiries, not your existing customers. For example: **Pipeline stage** is the stage/column where new leads land (the same one that sends your first "how can we help?" text).
3. **Add Action: Webhook** (under "Send Data" / "Custom Webhook").
   - Method: **POST**
   - URL: your **bot address** from Step 4
   - Leave the rest as default.
4. Click **Save**, then switch the workflow from Draft to **Publish**.

## Step 6: Test it

1. Add a test contact in GHL with **your own mobile number**, and put it in your new-lead pipeline stage so your first text goes out.
2. Reply from your phone: *"my kitchen tap is leaking"*.
3. Within about 10 seconds you should get a text back asking a follow-up question. Keep replying like a customer would (send a photo, say "Thursday arvo", give a suburb).
4. At the end, open the contact in GHL: you should see a **note** with the job summary, plus one of: a calendar appointment and tag **ai-booked**, a booking-request note and tag **ai-booking-requested**, or a callback note and tag **ai-callback**.

**Nothing happens?** In Vercel open your project > **Logs** and read the red line. Most likely causes:
- `unauthorized`: the password in the bot address doesn't match `WEBHOOK_SECRET`.
- A GHL error: the token is missing a permission from Step 2.
- No texts arriving at all: check your GHL SMS number is registered/verified (A2P 10DLC in the US; carrier rules elsewhere).

---

## Day to day

- **Take over a chat yourself:** add the tag `ai-stop` to the contact. The bot goes silent for them.
- **Booked contacts** get `ai-booked` (or `ai-booking-requested` with no calendar); **callback requests** get `ai-callback`. Set up GHL notifications on those tags (especially `ai-callback`, so the plumber rings on time) so the tradie sees new jobs. The bot keeps answering if they text again (e.g. to change the time).
- **Emergencies** (gas, sparks, flooding): the bot gives safety advice (mains off, 000 if anyone is in danger) and offers an immediate callback or the soonest booking. The only thing that stops the bot is the lead texting STOP (tags `ai-stop`) or you adding `ai-stop` yourself.
- The bot never quotes prices, and if asked it says it's a virtual assistant.
- It stops by itself after 20 messages with one lead.

## Changing how it talks

All the bot's instructions live in `lib/prompt.ts` (plain English inside). Edit it on GitHub (pencil icon), commit, and Vercel redeploys automatically.

## Later: booking straight into a calendar

Not used yet. When you want it, add the Environment Variable `GHL_CALENDAR_ID` (GHL > Calendars > your calendar's settings) and tick the Calendars permissions on your Private Integration. The bot will then offer real time slots and book them.
