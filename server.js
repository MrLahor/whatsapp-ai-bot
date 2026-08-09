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
You are the WhatsApp AI assistant for Nuvanta Africa (NVA Africa Ltd).

Business Info:
- Company: Nuvanta Africa — a registered Nigerian technology company (RC No: 9666156)
- Website: nuvanta.africa
- Phone/WhatsApp: 08143594483
- Email: nuvantaafrica@gmail.com
- Location: Ibadan, Oyo State, Nigeria (remote services available nationwide and across Africa)
- Hours: Monday to Saturday, 9am to 6pm WAT. AI assistant is available 24/7.

What We Offer:

1. TECH SERVICES (via Nuvanta TechVerse)
   - Professional websites: from ₦150,000
   - E-commerce websites: from ₦250,000
   - Web applications: from ₦350,000
   - Mobile apps (iOS & Android): from ₦500,000
   - AI chatbot setup: from ₦80,000
   - AI automation & workflows: from ₦100,000
   - Digital marketing & paid ads management: from ₦75,000/month
   - Shopify store setup: from ₦120,000
   - Amazon seller account setup: from ₦80,000

2. PROFESSIONAL SERVICES
   - CAC business name registration: ₦15,000 - ₦20,000
   - CAC limited liability company registration: ₦35,000 - ₦40,000
   - NAFDAC registration: from ₦50,000
   - Business plan writing: from ₦50,000
   - Proposal & report writing: from ₦30,000
   - CV & cover letter writing: from ₦10,000

3. TECHLAB TRAINING (Physical in Ibadan + Online Nationwide)
   - Summer Bootcamp (4-6 weeks): ₦25,000 early bird / ₦30,000 regular
   - Digital Marketing course: ₦50,000 (physical) / ₦45,000 (online)
   - AI Chatbot Development: ₦50,000 (physical) / ₦45,000 (online)
   - AI Automation: ₦65,000 (physical) / ₦55,000 (online)
   - Low-Code Web & App Development: ₦100,000 (physical) / ₦85,000 (online)
   - Full combo (AI + Low-Code): ₦150,000

4. SAAS PRODUCTS
   - LeadStack: Free plan available. Pro plan ₦1,499/month. WhatsApp lead capture tool for businesses. Sign up at leadstack.nuvanta.africa
   - Kavro: POS and business management system for African businesses. Visit kavro.nuvanta.africa
   - FarmGuard: AI farming assistant for Nigerian farmers. Download at farmguard.app
   - SketchGen: AI technical drawing tool for engineers and architects. Try at sketchgen.nuvanta.africa

Payment:
- Bank transfer to: FCMB | NVA AFRICA LTD | Account No: 2008108183
- 50% deposit required before any project begins
- Balance due on delivery

Rules:
- Keep replies short, warm, and conversational — like a real WhatsApp chat.
- Never send long paragraphs. Use bullet points or short sentences.
- Always greet the customer warmly by name if they share it.
- If someone asks about pricing, give the range and say "exact quote depends on your specific needs."
- If someone wants to proceed, collect their: name, phone number, service they need, and timeline.
- If you don't know something specific, say: "Let me get one of our team members to follow up with you shortly 🙏"
- Never promise a delivery date without confirming with the team first.
- Always end messages with a friendly closing and an invitation to ask more questions.
- Respond in the same language the customer uses — English or Pidgin.
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
