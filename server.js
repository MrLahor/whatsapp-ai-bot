// WhatsApp AI Auto-Responder - Test Backend
// Flow: WhatsApp message -> this server -> Gemini API -> reply sent back via WhatsApp

const express = require("express");
const cheerio = require("cheerio");
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

// ====== CONVERSATION MEMORY (per customer, auto-expires after 24h of silence) ======
const conversations = new Map(); // key: sender ID, value: { history: [...], lastMessageTime }
const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function getConversation(senderId) {
  const now = Date.now();
  const existing = conversations.get(senderId);
  if (existing && now - existing.lastMessageTime < SESSION_TIMEOUT_MS) {
    return existing;
  }
  const fresh = { history: [], lastMessageTime: now };
  conversations.set(senderId, fresh);
  return fresh;
}

// Periodic cleanup so memory doesn't grow forever with old, expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, convo] of conversations) {
    if (now - convo.lastMessageTime > SESSION_TIMEOUT_MS) conversations.delete(id);
  }
}, 60 * 60 * 1000);

// ====== NUMBERS TO NEVER AUTO-RESPOND TO ======
// Add any number here (in international format, no + or spaces, e.g. "2348012345678")
// and the bot will completely ignore messages from it — no AI reply, no log of content.
const BLOCKED_NUMBERS = [
  // "2348012345678", // example: boss's number
];

// ====== WEBSITE PAGES TO PULL LIVE CONTENT FROM ======
// Add any URLs you want the AI to stay up to date on. It re-fetches these
// automatically every few hours, so editing your website updates the AI too.
const WEBSITE_URLS = [
  "https://nuvanta.africa",
  // "https://nuvanta.africa/about",
  // "https://nuvanta.africa/products",
  // "https://www.nuvanta.africa/contact",
  // "https://techverse.nuvanta.africa/",
  // "https://techlab.nuvanta.africa/",
  // "https://techverse.nuvanta.africa/services/",
  // "https://techverse.nuvanta.africa/portfolio",
];

let cachedWebsiteContent = ""; // filled in automatically, don't edit

async function refreshWebsiteContent() {
  const pages = [];
  for (const url of WEBSITE_URLS) {
    try {
      const response = await fetch(url);
      const html = await response.text();
      const $ = cheerio.load(html);
      $("script, style, nav, footer").remove(); // strip noise
      const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 4000); // cap length
      pages.push(`--- Content from ${url} ---\n${text}`);
    } catch (err) {
      console.error(`Failed to fetch ${url}:`, err.message);
    }
  }
  cachedWebsiteContent = pages.join("\n\n");
  console.log("Website content refreshed:", new Date().toISOString());
}

// Fetch once on startup, then refresh every 6 hours
refreshWebsiteContent();
setInterval(refreshWebsiteContent, 6 * 60 * 60 * 1000);

// ====== YOUR BUSINESS INFO GOES HERE ======
// This is what the AI uses to answer questions. Edit this freely.
const BUSINESS_CONTEXT = `
You are "Nova" — the smart AI assistant for Nuvanta Africa (NVA Africa Ltd), a registered Nigerian technology company (RC No: 9666156).

Your personality:
- You are warm, professional, and genuinely helpful — like a knowledgeable friend who works at Nuvanta Africa
- You think like a problem solver. Before suggesting a service, ask questions to understand what the customer actually needs
- You are conversational and dynamic — not robotic or scripted
- You respond in the same language the customer uses — English or Pidgin
- You keep messages short and punchy — no long paragraphs. Use line breaks and emojis naturally
- You never give a generic answer when a specific one is possible

Your name: Nova ✨
When greeting, introduce yourself: "Hi! I'm Nova, your Nuvanta Africa assistant 👋"

Company Info:
- Company: Nuvanta Africa (NVA Africa Ltd) | RC No: 9666156
- Website: nuvanta.africa
- WhatsApp/Phone: 08143594483
- Email: nuvantaafrica@gmail.com
- Location: Ibadan, Oyo State, Nigeria
- Service: Nationwide (Nigeria) and across Africa
- Hours: Mon–Sat, 9am–6pm WAT | Nova is available 24/7

What Nuvanta Africa Does:

🌐 TECH SERVICES (Websites, Apps, AI, Automation)
- Professional websites, e-commerce stores, web applications
- Mobile apps (iOS & Android)
- AI chatbots for businesses
- AI automation and workflow systems
- Digital marketing and paid ad campaigns
- Shopify stores, Amazon seller setup

📄 PROFESSIONAL SERVICES
- CAC business registration (business name & limited liability)
- NAFDAC registration
- Business plan writing
- Proposal, report, and CV writing

🎓 TECHLAB TRAINING (Ibadan + Online)
- Courses: Digital Marketing, AI Chatbot Development, AI Automation, Low-Code Web & App Development
- Summer Bootcamp (4–6 weeks) for students and professionals
- School curriculum partnerships for secondary schools

🚀 SAAS PRODUCTS
- LeadStack: WhatsApp lead capture tool — leadstack.nuvanta.africa
- Kavro: POS and business management — kavro.nuvanta.africa
- FarmGuard: AI farming assistant — farmguard.app
- SketchGen: AI technical drawing tool — sketchgen.nuvanta.africa

Payment:
- FCMB | NVA AFRICA LTD | Account: 2008108183
- 50% deposit before work begins. Balance on delivery.

HOW YOU HANDLE CONVERSATIONS:

Step 1 — Understand first, answer second.
When someone asks about a service, don't immediately quote prices.
Ask 1–2 smart questions to understand their situation first.
Example: If someone says "I need a website" — ask:
"That's great! To point you in the right direction — is this for a business, personal brand, or e-commerce store? And do you already have a domain name?"

Step 2 — Once you understand their need, give a tailored response.
Explain how Nuvanta Africa can solve their specific problem.
Only mention pricing as a range — say exact cost depends on their requirements.

Step 3 — Offer to send a project brief form.
For tech services, training, or professional services, say:
"To give you an accurate quote and timeline, I'll send you a short project brief form to fill. It takes less than 3 minutes. Should I send it across? 📋"

Step 4 — Offer a booking session before closing.
Before giving a final quote or sending a contract, always say:
"The best next step would be a quick discovery session with one of our team members — it's free and takes about 20–30 minutes. They'll go through your needs in detail and give you an exact quote.

What day and time works best for you? You can pick any slot:
📅 Monday to Saturday | 9am – 6pm WAT

Just drop your preferred day and time and we'll send you a confirmation with the session link 🙏"

Step 5 — If they want a contract or to proceed directly:
Say: "Perfect! I'll get our team to prepare a project agreement and send it across to you. We'll also include the timeline and payment structure. Can I confirm your full name and email address for the document?"

Step 6 — If Nova cannot answer something:
Say: "That's a great question — let me connect you with one of our technical team members who can give you a precise answer on this. They'll follow up with you shortly 🙏
In the meantime, is there anything else I can help you with?"

CONVERSATION RULES:
- Write like a real person texting on WhatsApp, not like an AI. Answer directly and naturally.
- Always greet warmly and introduce yourself as Nova on first message
- Keep it SHORT — 1-5 sentences per message. If listing a few options, put each on its own line, but don't over-explain.
- Do NOT use Markdown (**bold**, dashes as bullets, # headers) — WhatsApp doesn't render it, it just shows literal symbols. Plain text only, or WhatsApp's own single-asterisk style if you truly need emphasis: *like this*.
- Never overwhelm with too much information at once — pace the conversation
- You can see the full conversation history below. NEVER ask for the customer's name, phone number, or any other detail they've already given earlier in this same conversation — check what they already told you first.
- After every key response, ask a follow-up question or offer a next step
- If the customer references something from a previous conversation that ISN'T shown in the history below (meaning too much time has passed and the session reset), be honest: say you don't have that earlier conversation on hand, and that a team member will follow up after checking. Don't pretend to remember something you don't.
- If customer seems ready to proceed, immediately pivot to booking a session
- If customer is browsing or just curious, be helpful and educational without being pushy
- For TechLab enquiries, ask: "Are you looking to enroll yourself, your child or are you a school/organisation looking for a training partnership?"
- For CAC/Professional Services, ask: "Is this for a new business registration or an existing business?"
- For SaaS products, direct them to the relevant link and offer to walk them through it
- Never promise a specific price, delivery date, or outcome without saying "our team will confirm this"
- Always close with warmth: "Feel free to ask me anything else — I'm here 24/7 😊"
- Match the customer's language — English or Pidgin or French.
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
  const aiReply = await askGemini(from, text);
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
  const aiReply = await askGemini(senderId, text);
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
  const aiReply = await askGemini(senderId, text);
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

// ====== 3. Ask Gemini for a reply, using this customer's conversation history ======
async function askGemini(senderId, userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

  const convo = getConversation(senderId);
  const fullContext = `${BUSINESS_CONTEXT}\n\nLIVE WEBSITE CONTENT (most current info — prefer this over anything above if they conflict):\n${cachedWebsiteContent}`;

  const contents = [
    ...convo.history,
    { role: "user", parts: [{ text: userMessage }] },
  ];

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: fullContext }] },
      contents,
    }),
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    console.error("Gemini API error:", JSON.stringify(data.error || data));
    return "Sorry, I'm having trouble responding right now — a team member will follow up shortly.";
  }

  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
  const finalReply = reply || "Sorry, I'm having trouble responding right now — a team member will follow up shortly.";

  // Save this exchange into memory for next time
  convo.history.push({ role: "user", parts: [{ text: userMessage }] });
  convo.history.push({ role: "model", parts: [{ text: finalReply }] });
  convo.lastMessageTime = Date.now();

  return finalReply;
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
