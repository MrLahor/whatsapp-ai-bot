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

// ====== NUMBERS TO NEVER AUTO-RESPOND TO ======
// Add any number here (in international format, no + or spaces, e.g. "2348012345678")
// and the bot will completely ignore messages from it — no AI reply, no log of content.
const BLOCKED_NUMBERS = [
  // "2348012345678", // example: boss's number
];

// ====== YOUR BUSINESS INFO GOES HERE ======
// This is what the AI uses to answer questions. Edit this freely.
const BUSINESS_CONTEXT = `
You are the WhatsApp assistant for [Your Business Name].
Business info:
- What we sell/offer: [describe your products/services]
- Prices: [list key prices]
- Hours: [e.g. Mon-Sat, 9am-6pm WAT]
- Location: [address or "online only"]
- Delivery/payment info: [if relevant]

Rules:
- Answer only using the info above.
- Keep replies short and friendly, like a real WhatsApp chat (not long paragraphs).
- If you don't know something, say a team member will follow up shortly.
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

// ====== 2. Receiving incoming WhatsApp messages ======
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // acknowledge immediately, Meta expects a fast response

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message) return; // could be a status update, not a real message

    const from = message.from; // customer's phone number
    const text = message.text?.body;

    if (!text) return; // ignore non-text messages for now

    if (BLOCKED_NUMBERS.includes(from)) {
      console.log(`Ignored message from blocked number ${from}`);
      return; // silently do nothing — no AI reply sent
    }

    console.log(`Message from ${from}: ${text}`);

    const aiReply = await askGemini(text);
    await sendWhatsAppMessage(from, aiReply);
  } catch (err) {
    console.error("Error handling incoming message:", err);
  }
});

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
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return reply || "Sorry, I'm having trouble responding right now — a team member will follow up shortly.";
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