// WhatsApp AI Auto-Responder - Test Backend
// Flow: WhatsApp message -> this server -> Gemini API -> reply sent back via WhatsApp

const express = require("express");
const app = express();
app.use(express.json());

// ====== FILL THESE IN (.env or directly here for quick testing) ======
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_test_verify_token_123"; // you make this up, used in Step 2 webhook setup
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "PASTE_YOUR_META_ACCESS_TOKEN_HERE";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "PASTE_YOUR_PHONE_NUMBER_ID_HERE";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "PASTE_YOUR_GEMINI_API_KEY_HERE";

// ====== FACEBOOK MESSENGER ======
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "PASTE_YOUR_PAGE_ACCESS_TOKEN_HERE";

// ====== INSTAGRAM ======
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || "PASTE_YOUR_INSTAGRAM_ACCESS_TOKEN_HERE";
const IG_ACCOUNT_ID = process.env.IG_ACCOUNT_ID || "PASTE_YOUR_INSTAGRAM_ACCOUNT_ID_HERE";

// ====== NUMBERS TO NEVER AUTO-RESPOND TO ======
// Add any number here (in international format, no + or spaces, e.g. "2348012345678")
// and the bot will completely ignore messages from it — no AI reply, no log of content.
const BLOCKED_NUMBERS = [
  // "2348012345678", // example: boss's number
];

// ====== YOUR BUSINESS INFO GOES HERE ======
// This is what the AI uses to answer questions. Edit this freely.
const BUSINESS_CONTEXT = `
You are the WhatsApp assistant for Nuvanta Africa (NVA Africa Ltd), answering customer messages directly — you ARE the business talking to them, not an AI describing the business.

COMPANY
- Nuvanta Africa — registered Nigerian technology company (RC No: 9666156)
- Website: nuvanta.africa | Email: nuvantaafrica@gmail.com | Phone/WhatsApp: 08143594483
- Location: Ibadan, Oyo State, Nigeria — remote services available nationwide and across Africa
- Human hours: Mon-Sat, 9am-6pm WAT. This assistant is available 24/7.

TECH SERVICES (Nuvanta TechVerse)
- Websites: from ₦150,000 | E-commerce sites: from ₦250,000 | Web apps: from ₦350,000
- Mobile apps (iOS & Android): from ₦500,000
- AI chatbot setup: from ₦80,000 | AI automation & workflows: from ₦100,000
- Digital marketing/ads management: from ₦75,000/month
- Shopify store setup: from ₦120,000 | Amazon seller account setup: from ₦80,000

PROFESSIONAL SERVICES
- CAC business name registration: ₦15,000-₦20,000
- CAC limited liability registration: ₦35,000-₦40,000
- NAFDAC registration: from ₦50,000
- Business plan writing: from ₦50,000 | Proposal/report writing: from ₦30,000
- CV & cover letter writing: from ₦10,000

TECHLAB TRAINING (Physical in Ibadan + Online nationwide)
- Summer Bootcamp (4-6 weeks): ₦25,000 early bird / ₦30,000 regular
- Digital Marketing: ₦50,000 physical / ₦45,000 online
- AI Chatbot Development: ₦50,000 physical / ₦45,000 online
- AI Automation: ₦65,000 physical / ₦55,000 online
- Low-Code Web & App Dev: ₦100,000 physical / ₦85,000 online
- Full combo (AI + Low-Code): ₦150,000

SAAS PRODUCTS
- LeadStack (WhatsApp lead capture tool): free plan available, Pro ₦1,499/month — leadstack.nuvanta.africa
- Kavro (POS & business management): kavro.nuvanta.africa
- FarmGuard (AI farming assistant): farmguard.app
- SketchGen (AI technical drawing tool): sketchgen.nuvanta.africa

PAYMENT
- Bank transfer: FCMB | NVA AFRICA LTD | Account No: 2008108183
- 50% deposit required before any project begins, balance due on delivery

HOW TO REPLY
- Write like a real person texting on WhatsApp, not like an AI. Never say
  things like "As an AI" or "I'd be happy to assist you." Just answer
  directly and naturally.
- Keep it SHORT — 1-3 sentences per message. If listing a few options, put
  each on its own line, but don't over-explain.
- Do NOT use Markdown (**bold**, dashes as bullets, # headers) — WhatsApp
  doesn't render it, it just shows literal symbols. Plain text only, or
  WhatsApp's own single-asterisk style if you truly need emphasis: *like this*.
- Greet the customer by name if they share it.
- For pricing questions, give the range and note the exact quote depends on
  their specific needs.
- If someone wants to proceed, collect: name, phone number, service needed,
  and timeline.
- Never promise a delivery date — that's confirmed by the team, not you.
- If you don't know something, say: "Let me get one of our team members to
  follow up with you shortly 🙏"
- Match the customer's language — English or Pidgin.
`;

// ====== 1. Webhook verification (Meta calls this once when you set up the webhook) ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ====== 2. Receiving incoming messages (WhatsApp, Messenger, or Instagram) ======
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // acknowledge immediately, Meta expects a fast response

  try {
    const platform = req.body.object; // "whatsapp_business_account" | "page" | "instagram"

    if (platform === "whatsapp_business_account") {
      await handleWhatsApp(req.body);
    } else if (platform === "page") {
      await handleMessenger(req.body);
    } else if (platform === "instagram") {
      await handleInstagram(req.body);
    }
  } catch (err) {
    console.error("Error handling incoming message:", err);
  }
});

// ---- WhatsApp ----
async function handleWhatsApp(body) {
  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];
  if (!message) return;

  const from = message.from;
  const text = message.text?.body;
  if (!text) return;

  if (BLOCKED_NUMBERS.includes(from)) {
    console.log(`Ignored WhatsApp message from blocked number ${from}`);
    return;
  }

  console.log(`WhatsApp message from ${from}: ${text}`);
  await markAsReadAndTyping(message.id);
  const aiReply = await askGemini(text);
  await sendWhatsAppMessage(from, aiReply);
}

// ---- Facebook Messenger ----
async function handleMessenger(body) {
  const entry = body.entry?.[0];
  const messaging = entry?.messaging?.[0];
  const senderId = messaging?.sender?.id;
  const text = messaging?.message?.text;
  if (!senderId || !text) return;

  console.log(`Messenger message from ${senderId}: ${text}`);
  const aiReply = await askGemini(text);
  await sendMessengerMessage(senderId, aiReply);
}

async function sendMessengerMessage(recipientId, text) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });
  const data = await response.json();
  if (!response.ok) console.error("Messenger send failed:", JSON.stringify(data));
}

// ---- Instagram ----
async function handleInstagram(body) {
  const entry = body.entry?.[0];
  const messaging = entry?.messaging?.[0];
  const senderId = messaging?.sender?.id;
  const text = messaging?.message?.text;
  if (!senderId || !text) return;

  console.log(`Instagram message from ${senderId}: ${text}`);
  const aiReply = await askGemini(text);
  await sendInstagramMessage(senderId, aiReply);
}

async function sendInstagramMessage(recipientId, text) {
  const url = `https://graph.facebook.com/v21.0/${IG_ACCOUNT_ID}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${IG_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });
  const data = await response.json();
  if (!response.ok) console.error("Instagram send failed:", JSON.stringify(data));
}

// ====== 3. Ask Gemini for a reply ======
async function askGemini(userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: `${BUSINESS_CONTEXT}\n\nCustomer message: "${userMessage}"\n\nYour reply:` }],
        },
      ],
    }),
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    console.error("Gemini API error:", JSON.stringify(data.error || data));
    return "Sorry, I'm having trouble responding right now — a team member will follow up shortly.";
  }

  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return reply || "Sorry, I'm having trouble responding right now — a team member will follow up shortly.";
}

// ====== 3.5 Show blue ticks + typing indicator while we prepare a reply ======
async function markAsReadAndTyping(messageId) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      }),
    });
  } catch (err) {
    console.error("Failed to mark as read / show typing:", err);
  }
}

// ====== 4. Send reply back via WhatsApp Cloud API ======
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("WhatsApp send failed:", JSON.stringify(data));
  } else {
    console.log(`Reply sent to ${to}`);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
