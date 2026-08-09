# WhatsApp AI Auto-Responder — Test Setup

## What this does
Customer messages your WhatsApp test number → this server receives it →
asks Gemini for a reply using your business info → sends the reply back
via WhatsApp. Fully automatic once running.

## 1. Fill in your credentials
Open `server.js` and replace these values (or set them as environment variables):
- `WHATSAPP_TOKEN` — from Meta's "Step 1: Try it out" screen (regenerate if it's expired)
- `PHONE_NUMBER_ID` — shown next to your test number in Meta dashboard
- `GEMINI_API_KEY` — from Google AI Studio (aistudio.google.com)
- `VERIFY_TOKEN` — make up any random string, e.g. `mySecret123` (you'll enter this same string in Meta's webhook setup)

Also edit the `BUSINESS_CONTEXT` block near the top with your real business info.

## 2. Install and run
```bash
npm install
npm start
```
This starts the server on `http://localhost:3000`.

## 3. Expose it to the internet (Meta needs a public URL)
Since Meta's servers need to reach your webhook, use a free tunnel while testing:
```bash
npx ngrok http 3000
```
This gives you a public URL like `https://abcd1234.ngrok-free.app`.

## 4. Connect the webhook in Meta
In your Meta app → WhatsApp → Configuration:
- **Callback URL**: `https://abcd1234.ngrok-free.app/webhook`
- **Verify token**: the same string you set as `VERIFY_TOKEN` above
- Click **Verify and Save**
- Subscribe to the **messages** field

## 5. Test it
Send a WhatsApp message to your test number from one of your 5 verified
recipient numbers. Within a few seconds you should get an AI-generated
reply based on your `BUSINESS_CONTEXT`.

## Notes
- Your access token from "Try it out" expires in ~24 hours — regenerate it
  and update `server.js` when it stops working.
- ngrok URLs change every time you restart it (on the free plan) — you'll
  need to re-paste the URL into Meta's webhook config each time.
- For a stable long-term URL (no re-pasting), deploy this to Railway or
  Render instead of running it locally with ngrok.
