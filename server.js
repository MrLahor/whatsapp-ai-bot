// WhatsApp AI Auto-Responder - Test Backend
// Flow: WhatsApp message -> this server -> Gemini API -> reply sent back via WhatsApp

const express = require("express");
const cheerio = require("cheerio");
const cors = require("cors");
const PDFDocument = require("pdfkit");
const app = express();
app.use(cors());
app.use(express.json());

// ====== FILL THESE IN (.env or directly here for quick testing) ======
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_test_verify_token_123"; // you make this up, used in Step 2 webhook setup
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "PASTE_YOUR_META_ACCESS_TOKEN_HERE";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "PASTE_YOUR_PHONE_NUMBER_ID_HERE";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "PASTE_YOUR_GEMINI_API_KEY_HERE";

// ====== BROADCAST PANEL ======
// A password you make up, used to access the /broadcast-panel page
const BROADCAST_SECRET = process.env.BROADCAST_SECRET || "PASTE_A_PASSWORD_HERE";

// ====== WHATSAPP FLOW (in-chat form) ======
// Get this ID after creating and publishing your Flow in WhatsApp Manager
const QUOTE_FLOW_ID = process.env.QUOTE_FLOW_ID || "PASTE_YOUR_FLOW_ID_HERE";

// ====== CUSTOM CRM (Supabase) ======
const SUPABASE_URL = process.env.SUPABASE_URL || "PASTE_YOUR_SUPABASE_PROJECT_URL_HERE";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "PASTE_YOUR_SUPABASE_ANON_KEY_HERE";
const CRM_SECRET = process.env.CRM_SECRET || "PASTE_A_PASSWORD_HERE"; // for viewing the leads dashboard

// ====== ALERT YOU WHEN A HUMAN NEEDS TO STEP IN ======
const OWNER_WHATSAPP_NUMBER = process.env.OWNER_WHATSAPP_NUMBER || "2348143594483";
const BASE_URL = process.env.BASE_URL || "https://whatsapp-ai-bot-b134.onrender.com";
// If any of your approved templates have an IMAGE header, put a public image
// URL here (e.g. your logo on your website). Leave as-is if none need one.
const TEMPLATE_HEADER_IMAGE = process.env.TEMPLATE_HEADER_IMAGE || "";

// ====== FACEBOOK MESSENGER ======
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "PASTE_YOUR_PAGE_ACCESS_TOKEN_HERE";

// ====== INSTAGRAM ======
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || "PASTE_YOUR_INSTAGRAM_ACCESS_TOKEN_HERE";
const IG_ACCOUNT_ID = process.env.IG_ACCOUNT_ID || "PASTE_YOUR_INSTAGRAM_ACCOUNT_ID_HERE";

// ====== CONVERSATION MEMORY (per customer, persisted in Supabase so it ======
// ====== survives server restarts — not just kept in RAM) ======
const SESSION_TIMEOUT_MS = Number(process.env.SESSION_TIMEOUT_HOURS || 48) * 60 * 60 * 1000;
const conversationCache = new Map(); // in-process cache, avoids hitting Supabase on every message in a fast back-and-forth

async function getConversation(senderId) {
  const now = Date.now();

  const cached = conversationCache.get(senderId);
  if (cached && now - cached.lastMessageTime < SESSION_TIMEOUT_MS) {
    return cached;
  }

  // Not in memory (likely a fresh server start) — check Supabase for a still-valid session
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/conversations?sender_id=eq.${encodeURIComponent(senderId)}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await response.json();
    const row = rows?.[0];
    if (row && now - new Date(row.last_message_time).getTime() < SESSION_TIMEOUT_MS) {
      const restored = { history: row.history || [], lastMessageTime: new Date(row.last_message_time).getTime() };
      conversationCache.set(senderId, restored);
      return restored;
    }
  } catch (err) {
    console.error("Failed to load conversation from Supabase:", err);
  }

  const fresh = { history: [], lastMessageTime: now };
  conversationCache.set(senderId, fresh);
  return fresh;
}

async function saveConversation(senderId, convo) {
  conversationCache.set(senderId, convo);
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/conversations`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        sender_id: senderId,
        history: convo.history,
        last_message_time: new Date(convo.lastMessageTime).toISOString(),
      }),
    });
  } catch (err) {
    console.error("Failed to save conversation to Supabase:", err);
  }
}

// Periodic cleanup of the in-process cache only — Supabase rows are cheap to keep
setInterval(() => {
  const now = Date.now();
  for (const [id, convo] of conversationCache) {
    if (now - convo.lastMessageTime > SESSION_TIMEOUT_MS) conversationCache.delete(id);
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
  // "https://nuvanta.africa/services",
  // "https://nuvanta.africa/pricing",
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
You are "Nova" — a customer engagement specialist at Nuvanta Africa (NVA Africa Ltd), a registered Nigerian technology company (RC No: 9666156). You're not just an FAQ bot — you're the front line of the business, and your job is to genuinely help people while moving the business forward: turning curious visitors into leads, leads into bookings, and questions into resolved problems.

Your personality:
- You are warm, professional, and genuinely helpful — like a sharp, likeable person who works at Nuvanta Africa and is good at their job
- You think like a problem solver. Before suggesting a service, ask questions to understand what the customer actually needs
- You are conversational and dynamic — not robotic or scripted
- You respond in the same language the customer uses — English, Pidgin, or French
- You keep messages short and punchy — no long paragraphs. Use line breaks and emojis naturally
- You never give a generic answer when a specific one is possible

Your name: Nova ✨
When greeting on the very first message of a conversation, introduce yourself: "Hi! I'm Nova, Digital Solutions Assistant at Nuvanta Africa 👋"

ADAPT YOUR ROLE TO WHAT THE MOMENT NEEDS
You're not locked into one mode — read the conversation and shift naturally,
the way a genuinely good salesperson-slash-support-agent would:
- Someone just browsing or asking "what do you guys do" → be a MARKETER:
  paint an exciting, specific picture of how Nuvanta Africa helps, without
  being pushy. Spark curiosity, don't info-dump.
- Someone comparing options or hesitating on price → be a SALES EXECUTIVE:
  focus on value, handle hesitation calmly, gently guide toward the next
  step (the form or discovery session) rather than just answering and
  stopping.
- Someone with a problem, complaint, or existing project question → be
  CUSTOMER SUPPORT: prioritize making them feel heard and resolving things
  smoothly, don't try to upsell in the same breath.
- Someone who hasn't shared contact info yet → think like LEAD
  ACQUISITION: naturally work toward capturing their details (following
  the WhatsApp/Messenger rules below) without ever feeling like an
  interrogation.
- Someone ready to talk to the team → be an APPOINTMENT SCHEDULER: get
  their preferred day/time smoothly and confirm what happens next.
Whatever role fits, the throughline is always the same: be genuinely
useful, move the conversation toward a real outcome (an answer, a booked
session, a resolved issue), and never just passively answer and go quiet.
Never sound like a generic script being read out — a real salesperson or
support agent reacts to what THIS specific person just said, uses their
name once you have it, and varies their phrasing message to message. If
two different customers ask the same question, your replies to them should
feel like a real conversation each time, not the same canned paragraph
copy-pasted twice.

USE DISCRETION — NOT EVERYONE IS A CUSTOMER
Before jumping into sales/service mode, think about who you're actually
talking to. Not every message is someone wanting to buy something —
recognize these situations and respond appropriately instead of forcing
them into your usual sales flow:
- Someone asking about a JOB, INTERNSHIP, IT industrial training/SIWES
  placement, or wanting to work at Nuvanta Africa — this is a
  recruitment/HR matter, not a sales opportunity. Do NOT offer to sell
  them a service (like CV writing) just because a keyword matches
  something in your service list. Instead, be warm and direct them
  properly: "For internship or job opportunities, please send your CV and
  a short intro to nuvantaafrica@gmail.com and our team will review it."
- Someone from the media, a potential business partner, a vendor trying to
  sell Nuvanta Africa something, or anyone clearly not seeking your
  services — acknowledge them politely and direct them to
  nuvantaafrica@gmail.com rather than running your usual sales playbook on
  them.
- If a message seems like it was meant for someone else, or is unrelated
  spam, respond briefly and don't force a sales conversation out of it.
Always think first: "Is this person actually here to buy or learn about
our services, or are they here for a different reason?" — then respond
like a rational person would, not like a script running on autopilot.

COMPANY INFO
- Company: Nuvanta Africa (NVA Africa Ltd) | RC No: 9666156
- Website: nuvanta.africa | WhatsApp/Phone: 08143594483 | Email: nuvantaafrica@gmail.com
- Location: Ibadan, Oyo State, Nigeria — service nationwide (Nigeria) and across Africa
- Hours: Mon-Sat, 9am-6pm WAT | Nova is available 24/7

WHAT NUVANTA AFRICA DOES

TECH SERVICES (Websites, Apps, AI, Automation)
- Professional websites, e-commerce stores, web applications
- Mobile apps (iOS & Android)
- AI chatbots for businesses, AI automation and workflow systems
- Digital marketing and paid ad campaigns
- Shopify stores, Amazon seller setup

PROFESSIONAL SERVICES
- CAC business registration (business name & limited liability)
- NAFDAC registration
- Business plan writing, proposal/report/CV writing

TECHLAB TRAINING (Ibadan + Online)
- Courses: Digital Marketing, AI Chatbot Development, AI Automation, Low-Code Web & App Development
- Summer Bootcamp (4-6 weeks) for students and professionals
- School curriculum partnerships for secondary schools

SAAS PRODUCTS
- LeadStack (WhatsApp lead capture): leadstack.nuvanta.africa
- Kavro (POS & business management): kavro.nuvanta.africa
- FarmGuard (AI farming assistant): farmguard.app
- SketchGen (AI technical drawing): sketchgen.nuvanta.africa

PAYMENT
- FCMB | NVA AFRICA LTD | Account: 2008108183
- 50% deposit before work begins. Balance on delivery.

HOW YOU HANDLE CONVERSATIONS

Step 1 — Understand first, answer second.
When someone asks about a service, don't immediately quote prices. Ask 1-2
smart questions to understand their situation first.
Example: "I need a website" → "That's great! To point you in the right
direction — is this for a business, personal brand, or e-commerce store?
And do you already have a domain name?"

Step 2 — Once you understand their need, give a tailored response.
Explain how Nuvanta Africa solves their specific problem. Only mention
pricing as a range — say the exact cost depends on their requirements.
NEVER give a final, specific price yourself under any circumstance — a
range only, always framed as needing team confirmation for the exact figure.

Step 3 — Offer to send a project brief form.
For tech services, training, or professional services, once they're
engaged and interested, say something like: "To give you an accurate quote
and timeline, I'll send you a short project brief form to fill — takes
less than 3 minutes. Should I send it across? 📋" If they agree, include
[BOOK_CALL] at the very start of your NEXT reply (see the technical note
on this tag below).

Step 4 — Offer a discovery session before closing.
Before implying a final quote or contract, say something like: "The best
next step would be a quick discovery session with one of our team members
— it's free and takes about 20-30 minutes. They'll go through your needs
in detail and give you an exact quote. What day and time works best for
you?" Note: you can collect their preferred day/time as information to
pass along, but you cannot actually confirm a slot or generate a real
booking link yourself — a team member finalizes that. Don't claim to send
a "confirmation with a session link" — instead say the team will confirm
the exact time with them shortly.

Step 5 — If they want a contract or to proceed directly.
Say: "Perfect! I'll get our team to prepare a project agreement and send
it across, including the timeline and payment structure. Can I confirm
your full name and email address for the document?" Once you have this,
use the SAVE_LEAD tag (see below).

Step 6 — If Nova cannot answer something.
Say: "That's a great question — let me connect you with one of our
technical team members who can give you a precise answer on this. They'll
follow up with you shortly 🙏 In the meantime, is there anything else I
can help you with?"

CONVERSATION RULES
- Write like a real person texting on WhatsApp, not like an AI. Answer
  directly and naturally.
- Always greet warmly and introduce yourself as Nova on the first message
  of a conversation only — don't reintroduce yourself every message.
- CRITICAL LENGTH RULE: most replies should be 1-2 short sentences — like a
  real person casually texting, not writing an essay. Nigerians on WhatsApp
  have short attention spans and won't read long blocks of text. NEVER send
  2-3 paragraphs. If you have more to say than fits in 2-3 sentences, say
  the most important part now and let the conversation continue naturally
  rather than dumping everything at once. If you genuinely must list
  options, use short one-line-each bullets and nothing else — no extra
  explaining around them.
- Do NOT use Markdown (**bold**, dashes as bullets, # headers) — WhatsApp
  doesn't render it, it just shows literal symbols. Plain text only, or
  WhatsApp's own single-asterisk style if you truly need emphasis: *like this*.
- NEVER use em dashes (—) anywhere. This is a classic AI writing tell that
  makes text feel robotic and instantly recognizable as AI-generated. Use a
  period, comma, or just start a new short sentence instead. Write the way
  a real Nigerian would text a friend, not the way an essay is written.
- Never overwhelm with too much information at once — pace the conversation.
- STRICT: ask only ONE question per message, ever. Never stack two
  questions together like "is this for X? And do you have Y?" — that reads
  like a form, not a chat. Ask the first thing, wait for their answer, then
  ask the next thing naturally in your following message.
- You can see the full conversation history below. NEVER ask for the
  customer's name, phone number, or any other detail they've already given
  earlier in this same conversation — check what they already told you first.
- After every key response, ask a follow-up question or offer a next step
  — but keep it to ONE short question, not several.
- If the customer references something from a previous conversation that
  ISN'T shown in the history below (meaning too much time has passed and
  the session reset), be honest: say you don't have that earlier
  conversation on hand, and that a team member will follow up after
  checking. Don't pretend to remember something you don't.
- If the customer seems ready to proceed, pivot toward Step 3 or Step 4.
- If the customer is browsing or just curious, be helpful and educational
  without being pushy.
- For TechLab enquiries, ask: "Are you looking to enroll yourself, your
  child, or are you a school/organisation looking for a training partnership?"
- For CAC/Professional Services, ask: "Is this for a new business
  registration or an existing business?"
- For SaaS products, direct them to the relevant link and offer to walk
  them through it.
- Never promise a specific price, delivery date, or outcome without saying
  "our team will confirm this."
- Match the customer's language — English, Pidgin, or French.

WHEN A MESSAGE STARTS WITH "[The customer is replying directly to..."
- This bracketed text is a system note, not something the customer typed —
  never repeat it back or mention the brackets. It tells you exactly which
  earlier message they're responding to (could be one of yours, or one of
  their own earlier messages), so answer specifically about that thing
  rather than giving a generic reply. For example, if they earlier
  mentioned two different options and now quote one of those specific
  messages asking "what about this," answer about that exact option, not
  a generic re-ask of what they meant.

WHEN SOMEONE JUST SAYS HI / HELLO / GOOD MORNING (nothing specific yet)
- Don't launch into a long explanation, and don't make it feel like a
  robotic menu being read out. Introduce yourself briefly and warmly, ask
  what brings them by, AND naturally ask their name in the same breath, the
  way a friendly person would when meeting someone new. You can still list
  a few options to make it easy for them to reply, but frame it casually,
  not like a numbered customer-service script. Example style: "Hi! I'm
  Nova from Nuvanta Africa 👋 What's your name, and what brings you by
  today? Could be a website, an app, AI automation, business registration,
  TechLab training, or something else entirely!" Keep the whole thing to
  2-3 sentences max, warm and conversational, not a clinical list.

IF THIS IS WHATSAPP
- You already know their phone number automatically — it's how they're
  messaging you. NEVER ask for their phone number on WhatsApp, it's
  redundant. Once you know their NAME and what they're interested in
  (service), that's enough to save them as a lead — don't wait for
  anything else.

IF THIS CONVERSATION IS ON MESSENGER OR INSTAGRAM (not WhatsApp)
- Unlike WhatsApp, you do NOT automatically know their phone number here —
  you must actively ask for it.
- If this is the very first message in the conversation (no earlier
  history shown below), answer their question first, then also naturally
  ask for their WhatsApp number so we can follow up and keep them updated
  there — this helps capture them as a lead even if they don't need the
  tech team right away.
- Don't ask for their number as a blunt, standalone demand like "please
  give me your WhatsApp number." Weave it naturally into what you're
  already saying — for example, when confirming next steps: "I'll get our
  team to follow up with the full details — what's the best WhatsApp
  number to reach you on?" It should feel like a normal part of the
  conversation, not a form field.
- Once they show real interest, ask for their WhatsApp number specifically
  so the team can follow up there. If they don't want to share it, ask for
  their email instead.

TECHNICAL NOTE — BOOKING TAG (invisible to the customer)
- When Step 3 applies (sending the project brief form), include the exact
  tag [BOOK_CALL] at the very start of your reply, before your message. On
  WhatsApp this opens an in-chat form; on other platforms a link is added
  automatically after your message — don't write out a fake link yourself.
- Only use this when they're genuinely ready to move forward, not for
  casual pricing questions.

TECHNICAL NOTE — PAYMENT CLAIMS (invisible to the customer)
- When a customer says they've made a payment (bank transfer or otherwise),
  do NOT promise or send a receipt yourself — you can't confirm payments,
  only a human checking the bank account can. Respond warmly but honestly:
  something like "Thanks! We're confirming this now, it usually doesn't
  take long. You'll get your receipt automatically the moment it's
  confirmed." Then include this exact tag anywhere in your reply (removed
  before the customer sees it):
  [PAYMENT_CLAIM:{"name":"their name if known","service":"what they say they paid for","amount":"the amount they mentioned","notes":"anything else relevant"}]
- If a PAYMENT STATUS note appears in your context below, use it to answer
  naturally if they ask about their payment — e.g. if it's still pending,
  reassure them it's being checked; if it's confirmed, remind them their
  receipt was already sent. Don't repeat the [PAYMENT_CLAIM] tag for a
  payment that's already showing as pending or confirmed in that note.

TECHNICAL NOTE — SAVING LEAD INFO (invisible to the customer)
- Only use this for genuine potential CUSTOMERS interested in a paid
  service — not for job seekers, internship inquiries, media, partners, or
  vendors. Those get directed to nuvantaafrica@gmail.com instead, per the
  discretion guidance above, and should not be saved as a sales lead.
- On WhatsApp: once you know their NAME and what they want (service), save
  immediately — phone number is filled in automatically by the system, you
  don't need to have it or ask for it.
- Save their number if they mention their name to you by themselves even if you didn't ask them, save it as a lead from WhatsApp,if from other platforms, ask for their WhatsApp number.
- On Messenger/Instagram: you need their NAME AND (phone number OR email)
  AND what they're interested in before saving.
- Include this exact tag anywhere in your reply (it will be removed before
  the customer sees it):
  [SAVE_LEAD:{"name":"their name","phone":"their number or empty string","email":"their email or empty string","service":"what they want","notes":"anything else useful, including any preferred day/time they mentioned for a discovery session"}]
- Only include this once you actually have real info to save — never
  invent placeholder values. On WhatsApp, leave "phone" as an empty string
  since it's filled in automatically.
`;

// ====== Save a lead to the custom CRM (Supabase) ======
// ====== Look up a returning customer's name from their lead history ======
async function getKnownName(senderId) {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/leads?sender_id=eq.${encodeURIComponent(senderId)}&name=not.is.null&order=created_at.desc&limit=1&select=name`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await response.json();
    return rows?.[0]?.name || null;
  } catch (err) {
    console.error("Failed to look up known name:", err);
    return null;
  }
}

async function saveLead(platform, senderId, leadData) {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        platform,
        sender_id: senderId,
        name: leadData.name || null,
        phone: leadData.phone || null,
        email: leadData.email || null,
        service_interest: leadData.service || null,
        notes: leadData.notes || null,
      }),
    });
    if (!response.ok) console.error("Failed to save lead:", await response.text());
    else console.log(`Lead saved for ${senderId}`);
  } catch (err) {
    console.error("Error saving lead:", err);
  }
}

// ====== Summarize a full conversation for the owner alert (not just the last message) ======
async function summarizeConversation(senderId) {
  const convo = await getConversation(senderId);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

  const summaryInstruction =
    "Summarize this customer conversation in 3-5 short sentences for a busy business owner. " +
    "Include: what they need/want, any key requirements or details they mentioned, budget or " +
    "timeline if discussed, and their name/contact info if they gave it. Be specific, not generic. " +
    "Write in PLAIN TEXT ONLY — no Markdown, no **bold**, no bullet points with asterisks or dashes, " +
    "no headers. Just plain flowing sentences, since this gets sent as a WhatsApp message where " +
    "Markdown symbols show up as literal characters.";

  const contents = [...convo.history, { role: "user", parts: [{ text: summaryInstruction }] }];

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents }),
    });
    const data = await response.json();
    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return summary || "Could not generate summary — check the leads dashboard or Render logs for the full conversation.";
  } catch (err) {
    console.error("Failed to summarize conversation:", err);
    return "Could not generate summary — check the leads dashboard or Render logs for the full conversation.";
  }
}

// ====== Process an AI reply: strip special tags, act on them, return clean text ======
async function processAIReply(aiReply, platform, senderId, userMessage) {
  let cleanReply = aiReply;
  let shouldBookCall = false;

  const saveLeadMatch = cleanReply.match(/\[SAVE_LEAD:(\{.*?\})\]/);
  if (saveLeadMatch) {
    try {
      const leadData = JSON.parse(saveLeadMatch[1]);
      // On WhatsApp, the sender ID IS their phone number — always use it,
      // never rely on the AI having asked for it separately.
      if (platform === "WhatsApp" && !leadData.phone) {
        leadData.phone = senderId;
      }
      await saveLead(platform, senderId, leadData);
    } catch (err) {
      console.error("Failed to parse SAVE_LEAD tag:", err);
    }
    cleanReply = cleanReply.replace(saveLeadMatch[0], "").trim();
  }

  const paymentClaimMatch = cleanReply.match(/\[PAYMENT_CLAIM:(\{.*?\})\]/);
  if (paymentClaimMatch) {
    try {
      const claimData = JSON.parse(paymentClaimMatch[1]);
      await savePaymentClaim(platform, senderId, claimData);
      await notifyOwner(
        `Payment claim (${platform})\nCustomer: ${senderId}\nName: ${claimData.name || "-"}\nService: ${claimData.service || "-"}\nAmount claimed: ${claimData.amount || "-"}\n\nCheck your bank, then confirm at: ${BASE_URL}/pending-payments`
      );
    } catch (err) {
      console.error("Failed to parse PAYMENT_CLAIM tag:", err);
    }
    cleanReply = cleanReply.replace(paymentClaimMatch[0], "").trim();
  }

  if (cleanReply.startsWith("[BOOK_CALL]")) {
    shouldBookCall = true;
    cleanReply = cleanReply.replace("[BOOK_CALL]", "").trim();

    if (platform !== "WhatsApp") {
      const formLink = `${BASE_URL}/book-session?platform=${platform}&sender=${senderId}`;
      cleanReply = `${cleanReply}\n\n${formLink}`;
    }

    const summary = await summarizeConversation(senderId);
    await notifyOwner(
      `Platform: ${platform}\nCustomer: ${senderId}\n\n${summary}\n\nThey're ready to move forward — check the leads dashboard for full details.`
    );
  }

  return { cleanReply, shouldBookCall };
}

// ====== Booking form — Messenger/Instagram equivalent of WhatsApp's in-chat Flow ======
app.get("/book-session", (req, res) => {
  const { platform, sender } = req.query;
  res.send(`
    <html><body style="font-family: sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px;">
      <h2>Book a Session with Our Tech Team</h2>
      <p>Fill this quick form and we'll follow up with a full quote.</p>
      <form method="POST" action="/book-session">
        <input type="hidden" name="platform" value="${platform || ""}">
        <input type="hidden" name="sender" value="${sender || ""}">
        <label>Name<br><input type="text" name="name" style="width:100%; padding:8px;" required></label><br><br>
        <label>WhatsApp Number<br><input type="text" name="phone" style="width:100%; padding:8px;" placeholder="e.g. 2348012345678"></label><br><br>
        <label>Email (if no WhatsApp number)<br><input type="email" name="email" style="width:100%; padding:8px;"></label><br><br>
        <label>What do you need?<br><input type="text" name="service" style="width:100%; padding:8px;" required></label><br><br>
        <label>Anything else to add?<br><textarea name="notes" rows="4" style="width:100%; padding:8px;"></textarea></label><br><br>
        <button type="submit" style="padding:10px 20px;">Submit</button>
      </form>
    </body></html>
  `);
});

app.post("/book-session", express.urlencoded({ extended: true }), async (req, res) => {
  const { platform, sender, name, phone, email, service, notes } = req.body;

  await saveLead(platform || "Web Form", sender || "unknown", { name, phone, email, service, notes });
  await notifyOwner(
    `Booking form submitted (${platform || "Web"})\nName: ${name}\nPhone: ${phone || "-"}\nEmail: ${email || "-"}\nService: ${service}\nNotes: ${notes || "-"}`
  );

  // Confirm to the customer in their original chat, if we know the platform/sender
  const confirmMsg = "Thanks! We've got your details — our team will follow up shortly 🙏";
  if (platform === "Messenger") await sendMessengerMessage(sender, confirmMsg);
  else if (platform === "Instagram") await sendInstagramMessage(sender, confirmMsg);

  res.send(`<body style="font-family: sans-serif; text-align:center; margin-top:60px;"><h2>Thanks, ${name}! 🎉</h2><p>Our team will follow up with you shortly.</p></body>`);
});

// ====== Leads dashboard — simple password-protected page to view your CRM ======
// ====== Generate a payment receipt PDF ======
function generateReceiptPDF({ customerName, service, amount, date, receiptNumber }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text("Nuvanta Africa", { align: "center" });
    doc.fontSize(10).fillColor("#555").text("NVA Africa Ltd | RC No: 9666156", { align: "center" });
    doc.moveDown(2);

    doc.fontSize(16).fillColor("#000").text("Payment Receipt", { align: "center" });
    doc.moveDown();
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown();

    doc.fontSize(11);
    doc.text(`Receipt No: ${receiptNumber}`);
    doc.text(`Date: ${date}`);
    doc.moveDown();
    doc.text(`Received from: ${customerName}`);
    doc.text(`For: ${service}`);
    doc.moveDown();

    doc.fontSize(14).text(`Amount Paid: ₦${amount}`, { align: "left" });
    doc.moveDown(3);

    doc.fontSize(10).fillColor("#555").text("Thank you for your business!", { align: "center" });
    doc.text("Nuvanta Africa | nuvanta.africa | 08143594483", { align: "center" });

    doc.end();
  });
}

// ====== Upload a file to WhatsApp so it can be sent as a document ======
async function uploadWhatsAppMedia(buffer, mimeType, filename) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([buffer], { type: mimeType }), filename);

  const response = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    body: form,
  });
  const data = await response.json();
  if (!response.ok) {
    console.error("Media upload failed:", JSON.stringify(data));
    return null;
  }
  return data.id;
}

async function sendWhatsAppDocument(to, mediaId, filename, caption) {
  const response = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: { id: mediaId, filename, caption },
    }),
  });
  const data = await response.json();
  if (!response.ok) console.error("Document send failed:", JSON.stringify(data));
  return response.ok;
}

// ====== Save a customer's payment claim as "pending" ======
async function savePaymentClaim(platform, senderId, claimData) {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/payments`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        platform,
        sender_id: senderId,
        phone: platform === "WhatsApp" ? senderId : claimData.phone || null,
        customer_name: claimData.name || null,
        service: claimData.service || null,
        amount: claimData.amount || null,
        notes: claimData.notes || null,
        status: "pending",
      }),
    });
    if (!response.ok) console.error("Failed to save payment claim:", await response.text());
  } catch (err) {
    console.error("Error saving payment claim:", err);
  }
}

// ====== Look up this customer's most recent payment status, for context ======
async function getPaymentStatus(senderId) {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/payments?sender_id=eq.${encodeURIComponent(senderId)}&order=id.desc&limit=1&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await response.json();
    return rows?.[0] || null;
  } catch (err) {
    console.error("Failed to look up payment status:", err);
    return null;
  }
}

// ====== Pending payments admin page — see claims and confirm with one click ======
app.get("/pending-payments", async (req, res) => {
  if (req.query.secret !== BROADCAST_SECRET) {
    return res.send('<form>Password: <input type="password" name="secret"><button>View</button></form>');
  }
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/payments?status=eq.pending&order=id.desc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const pending = await response.json();
    const rows = pending
      .map(
        (p) => `<tr>
          <td>${p.customer_name || "-"}</td>
          <td>${p.phone || p.sender_id}</td>
          <td>${p.service || "-"}</td>
          <td>₦${p.amount || "-"}</td>
          <td>${p.notes || "-"}</td>
          <td><a href="/confirm-payment?id=${p.id}&secret=${req.query.secret}" style="background:#0F5132;color:white;padding:6px 12px;text-decoration:none;border-radius:4px;">Confirm & Send Receipt</a></td>
        </tr>`
      )
      .join("");
    res.send(`
      <html><body style="font-family: sans-serif;">
        <h2>Pending Payments (${pending.length})</h2>
        <table border="1" cellpadding="8" style="border-collapse: collapse;">
          <tr><th>Name</th><th>Contact</th><th>Service</th><th>Amount</th><th>Notes</th><th>Action</th></tr>
          ${rows}
        </table>
      </body></html>
    `);
  } catch (err) {
    res.send("Error loading pending payments: " + err.message);
  }
});

// ====== Confirm a payment — generates and sends the receipt automatically ======
app.get("/confirm-payment", async (req, res) => {
  const { id, secret } = req.query;
  if (secret !== BROADCAST_SECRET) return res.send("Wrong password.");

  try {
    const getRes = await fetch(`${SUPABASE_URL}/rest/v1/payments?id=eq.${id}&select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const rows = await getRes.json();
    const payment = rows?.[0];
    if (!payment) return res.send("Payment claim not found.");

    const receiptNumber = `NVA-${Date.now().toString().slice(-8)}`;
    const date = new Date().toLocaleDateString("en-GB", { timeZone: "Africa/Lagos" });

    const pdfBuffer = await generateReceiptPDF({
      customerName: payment.customer_name || "Customer",
      service: payment.service || "Services rendered",
      amount: payment.amount || "0",
      date,
      receiptNumber,
    });
    const mediaId = await uploadWhatsAppMedia(pdfBuffer, "application/pdf", `Receipt-${receiptNumber}.pdf`);

    let sent = false;
    if (mediaId && payment.platform === "WhatsApp") {
      sent = await sendWhatsAppDocument(
        payment.phone || payment.sender_id,
        mediaId,
        `Receipt-${receiptNumber}.pdf`,
        `Your payment has been confirmed! Here's your receipt, ${payment.customer_name || ""}. Thank you 🙏`
      );
    }

    await fetch(`${SUPABASE_URL}/rest/v1/payments?id=eq.${id}`, {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "confirmed", receipt_number: receiptNumber }),
    });

    res.send(
      sent
        ? `Confirmed! Receipt ${receiptNumber} sent automatically. <br><a href="/pending-payments?secret=${secret}">Back to pending</a>`
        : `Marked confirmed, but the WhatsApp send may have failed (check Render logs), or this was a Messenger/Instagram lead without an auto-send path yet. <br><a href="/pending-payments?secret=${secret}">Back to pending</a>`
    );
  } catch (err) {
    console.error("Confirm payment failed:", err);
    res.send("Something went wrong. Check Render logs.");
  }
});

app.get("/leads", async (req, res) => {
  if (req.query.secret !== CRM_SECRET) {
    return res.send('<form>Password: <input type="password" name="secret"><button>View</button></form>');
  }
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/leads?order=created_at.desc`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const leads = await response.json();
    const rows = leads
      .map(
        (l) =>
          `<tr><td>${l.created_at?.slice(0, 16)}</td><td>${l.platform}</td><td>${l.name || ""}</td><td>${l.phone || ""}</td><td>${l.email || ""}</td><td>${l.service_interest || ""}</td><td>${l.notes || ""}</td></tr>`
      )
      .join("");
    res.send(`
      <html><body style="font-family: sans-serif;">
        <h2>Leads (${leads.length})</h2>
        <table border="1" cellpadding="8" style="border-collapse: collapse;">
          <tr><th>Date</th><th>Platform</th><th>Name</th><th>Phone</th><th>Email</th><th>Service</th><th>Notes</th></tr>
          ${rows}
        </table>
      </body></html>
    `);
  } catch (err) {
    res.send("Error loading leads: " + err.message);
  }
});

// ====== JSON API — call this from your Lovable dashboard to send a broadcast ======
app.post("/api/broadcast", async (req, res) => {
  const { secret, template, message, numbers } = req.body;

  if (secret !== BROADCAST_SECRET) {
    return res.status(401).json({ error: "Wrong password" });
  }
  if (!template || !Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: "Missing template or numbers list" });
  }

  const results = [];
  for (const number of numbers) {
    const cleanNumber = number.trim();
    let personalizedMessage = message || "";
    if (personalizedMessage.includes("{{name}}")) {
      const knownName = await getKnownName(cleanNumber);
      personalizedMessage = personalizedMessage.replace(/\{\{name\}\}/gi, knownName || "there");
    }
    const bodyParams = personalizedMessage ? [personalizedMessage] : [];
    const success = await sendWhatsAppTemplate(cleanNumber, template, bodyParams, TEMPLATE_HEADER_IMAGE || null);
    results.push({ number: cleanNumber, success });
  }

  res.json({ sent: results.filter((r) => r.success).length, failed: results.filter((r) => !r.success).length, results });
});

// ====== Broadcast panel — a simple password-protected page to send to many numbers ======
app.get("/broadcast-panel", (req, res) => {
  res.send(`
    <html><body style="font-family: sans-serif; max-width: 500px; margin: 40px auto;">
      <h2>Send Broadcast</h2>
      <form method="POST" action="/broadcast">
        <label>Password<br><input type="password" name="secret" style="width:100%; padding:8px;" required></label><br><br>
        <label>Template name (e.g. weekly_update)<br><input type="text" name="template" style="width:100%; padding:8px;" required></label><br><br>
        <label>Your message this week (type {{name}} anywhere to personalize per recipient)<br>
          <textarea name="message" rows="4" style="width:100%; padding:8px;" placeholder="Hi {{name}}, exciting news this week..."></textarea>
        </label><br><br>
        <label>Phone numbers (one per line, international format, no + or spaces)<br>
          <textarea name="numbers" rows="8" style="width:100%; padding:8px;" required placeholder="2348143594483&#10;2348140458307"></textarea>
        </label><br><br>
        <button type="submit" style="padding:10px 20px;">Send Broadcast</button>
      </form>
    </body></html>
  `);
});

app.post("/broadcast", express.urlencoded({ extended: true }), async (req, res) => {
  const { secret, template, message, numbers } = req.body;

  if (secret !== BROADCAST_SECRET) {
    return res.send("Wrong password.");
  }

  const numberList = numbers.split("\n").map((n) => n.trim()).filter(Boolean);
  const results = [];

  for (const number of numberList) {
    let personalizedMessage = message || "";
    if (personalizedMessage.includes("{{name}}")) {
      const knownName = await getKnownName(number);
      personalizedMessage = personalizedMessage.replace(/\{\{name\}\}/gi, knownName || "there");
    }
    const bodyParams = personalizedMessage ? [personalizedMessage] : [];
    const success = await sendWhatsAppTemplate(number, template, bodyParams, TEMPLATE_HEADER_IMAGE || null);
    results.push(`${number}: ${success ? "sent" : "FAILED"}`);
  }

  res.send(`<pre>${results.join("\n")}</pre><br><a href="/broadcast-panel">Send another</a>`);
});

// Template parameters can't contain line breaks, tabs, or 4+ consecutive
// spaces — WhatsApp rejects those outright. Clean automatically so every
// caller doesn't need to remember this.
function sanitizeTemplateParam(text) {
  return text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

async function sendWhatsAppTemplate(to, templateName, bodyParams = [], headerImageUrl = null) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const template = { name: templateName, language: { code: "en" } };
  const components = [];

  if (headerImageUrl) {
    components.push({ type: "header", parameters: [{ type: "image", image: { link: headerImageUrl } }] });
  }
  if (bodyParams.length) {
    components.push({
      type: "body",
      parameters: bodyParams.map((p) => ({ type: "text", text: sanitizeTemplateParam(p) })),
    });
  }
  if (components.length) template.components = components;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template }),
  });
  const data = await response.json();
  if (!response.ok) console.error(`Template "${templateName}" send to ${to} failed:`, JSON.stringify(data));
  return response.ok;
}

// ====== Alert the owner via WhatsApp when a human needs to step in ======
// Tries a normal message first (instant, works if you've messaged the bot
// recently); falls back to an approved template if that fails (guarantees
// delivery even outside the 24h window). Requires a template named
// "lead_alert" with one body variable, e.g.: "New lead alert: {{1}}"
async function notifyOwner(summary) {
  const sent = await sendWhatsAppMessage(OWNER_WHATSAPP_NUMBER, `🔔 Human needed:\n\n${summary}`);
  if (!sent) {
    console.log("Instant alert failed, falling back to template...");
    await sendWhatsAppTemplate(OWNER_WHATSAPP_NUMBER, "lead_alert", [summary.slice(0, 1000)], TEMPLATE_HEADER_IMAGE || null);
  }
}

// ====== Send the interactive quote-request Flow (form) to a customer ======
async function sendQuoteFlow(to) {
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
      type: "interactive",
      interactive: {
        type: "flow",
        header: { type: "text", text: "Get a Quote" },
        body: { text: "Fill this quick form and our team will get back to you with a full quote." },
        footer: { text: "Nuvanta Africa" },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_id: QUOTE_FLOW_ID,
            flow_cta: "Fill Form",
            flow_action: "navigate",
            flow_action_payload: { screen: "QUOTE_FORM" },
          },
        },
      },
    }),
  });
  const data = await response.json();
  if (!response.ok) console.error("Failed to send Flow:", JSON.stringify(data));
}

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

// ====== Download an image/audio file WhatsApp sent us ======
async function downloadWhatsAppMedia(mediaId) {
  const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const metaData = await metaRes.json();

  const fileRes = await fetch(metaData.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const arrayBuffer = await fileRes.arrayBuffer();
  const base64Data = Buffer.from(arrayBuffer).toString("base64");

  return { base64Data, mimeType: metaData.mime_type };
}

// ---- WhatsApp ----
// ====== Wait for a pause before replying (proxy for "they might still be typing") ======
// WhatsApp/Messenger/Instagram don't expose real typing status to businesses,
// so this waits a few seconds after each message — if more messages arrive
// in that window, they're combined into one before the AI replies.
const messageBuffers = new Map(); // senderId -> { texts: [], media, timer }
const DEBOUNCE_MS = 6000;

function bufferAndDebounce(senderId, text, media, onReady) {
  let buf = messageBuffers.get(senderId);
  if (!buf) {
    buf = { texts: [], media: null };
    messageBuffers.set(senderId, buf);
  }
  if (text) buf.texts.push(text);
  if (media) buf.media = media;

  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    const combinedText = buf.texts.join("\n");
    const combinedMedia = buf.media;
    messageBuffers.delete(senderId);
    onReady(combinedText, combinedMedia);
  }, DEBOUNCE_MS);
}

async function handleWhatsApp(body) {
  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];
  if (!message) return;

  const from = message.from;
  if (BLOCKED_NUMBERS.includes(from)) {
    console.log(`Ignored WhatsApp message from blocked number ${from}`);
    return;
  }

  let text = message.text?.body;
  let media = null;

  // Capture a submitted Flow (form) response
  if (message.type === "interactive" && message.interactive?.type === "nfm_reply") {
    const formData = JSON.parse(message.interactive.nfm_reply.response_json);
    console.log(`Form submitted by ${from}:`, JSON.stringify(formData));
    await saveLead("WhatsApp", from, {
      name: formData.name,
      phone: formData.phone || from,
      service: formData.service,
      notes: formData.details,
    });
    await notifyOwner(
      `Form submitted on WhatsApp\nName: ${formData.name}\nPhone: ${formData.phone || from}\nService: ${formData.service}\nDetails: ${formData.details || "-"}`
    );
    await sendWhatsAppMessage(from, "Thanks! We've got your details — our team will follow up shortly with your quote 🙏");
    return;
  }

  if (message.type === "image") {
    media = await downloadWhatsAppMedia(message.image.id);
    text = message.image.caption || "[Customer sent an image — look at it and respond helpfully.]";
  } else if (message.type === "audio") {
    media = await downloadWhatsAppMedia(message.audio.id);
    text = "[Customer sent a voice note — listen to it and respond helpfully.]";
  }

  if (!text && !media) return; // unsupported message type (video, sticker, etc.)

  // Store this incoming message's raw text (before any augmentation) so it
  // can itself be looked up later if the customer quotes it in a future message
  if (text) messageStore.set(message.id, { text, time: Date.now() });

  // If they replied/quoted an earlier message — whether it was Nova's or
  // their own — tell the AI exactly what was quoted
  if (message.context?.id) {
    const quoted = messageStore.get(message.context.id);
    if (quoted) {
      text = `[The customer is replying directly to this earlier message: "${quoted.text}"]\n${text}`;
    }
  }

  console.log(`WhatsApp message from ${from}: ${text}`);
  await markAsReadAndTyping(message.id);

  bufferAndDebounce(from, text, media, async (combinedText, combinedMedia) => {
    const aiReply = await askGemini(from, combinedText, "WhatsApp", combinedMedia);
    const { cleanReply, shouldBookCall } = await processAIReply(aiReply, "WhatsApp", from, combinedText);
    await sendWhatsAppMessage(from, cleanReply);
    if (shouldBookCall) await sendQuoteFlow(from);
  });
}

// ====== Download an image/audio file Messenger or Instagram sent us (direct URL, no auth needed) ======
async function downloadMetaMedia(url) {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const base64Data = Buffer.from(arrayBuffer).toString("base64");
  const mimeType = response.headers.get("content-type") || "application/octet-stream";
  return { base64Data, mimeType };
}

// ---- Facebook Messenger ----
async function handleMessenger(body) {
  const entry = body.entry?.[0];
  const messaging = entry?.messaging?.[0];
  const senderId = messaging?.sender?.id;
  if (!senderId) return;

  let text = messaging?.message?.text;
  let media = null;

  const attachment = messaging?.message?.attachments?.[0];
  if (attachment?.type === "audio") {
    media = await downloadMetaMedia(attachment.payload.url);
    text = "[Customer sent a voice note — listen to it and respond helpfully.]";
  } else if (attachment?.type === "image") {
    media = await downloadMetaMedia(attachment.payload.url);
    text = "[Customer sent an image — look at it and respond helpfully.]";
  }

  if (!text && !media) return; // unsupported attachment type (video, file, etc.)

  console.log(`Messenger message from ${senderId}: ${text}`);
  bufferAndDebounce(senderId, text, media, async (combinedText, combinedMedia) => {
    const aiReply = await askGemini(senderId, combinedText, "Messenger", combinedMedia);
    const { cleanReply } = await processAIReply(aiReply, "Messenger", senderId, combinedText);
    await sendMessengerMessage(senderId, cleanReply);
  });
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
  if (!senderId) return;

  let text = messaging?.message?.text;
  let media = null;

  const attachment = messaging?.message?.attachments?.[0];
  if (attachment?.type === "audio") {
    media = await downloadMetaMedia(attachment.payload.url);
    text = "[Customer sent a voice note — listen to it and respond helpfully.]";
  } else if (attachment?.type === "image") {
    media = await downloadMetaMedia(attachment.payload.url);
    text = "[Customer sent an image — look at it and respond helpfully.]";
  }

  if (!text && !media) return; // unsupported attachment type (video, file, etc.)

  console.log(`Instagram message from ${senderId}: ${text}`);
  bufferAndDebounce(senderId, text, media, async (combinedText, combinedMedia) => {
    const aiReply = await askGemini(senderId, combinedText, "Instagram", combinedMedia);
    const { cleanReply } = await processAIReply(aiReply, "Instagram", senderId, combinedText);
    await sendInstagramMessage(senderId, cleanReply);
  });
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
async function askGemini(senderId, userMessage, platform, media = null) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

  const convo = await getConversation(senderId);

  let knownNameNote = "";
  if (convo.history.length === 0) {
    const knownName = await getKnownName(senderId);
    if (knownName) {
      knownNameNote = `\n\nRETURNING CUSTOMER: This is a new session, but we've spoken with this customer before and know their name is ${knownName}. Greet them warmly by name (e.g. "Hey ${knownName}, welcome back! 👋") instead of your full generic first-time introduction, and don't ask for their name again since we already have it.`;
    }
  }

  let paymentStatusNote = "";
  const paymentStatus = await getPaymentStatus(senderId);
  if (paymentStatus) {
    if (paymentStatus.status === "pending") {
      paymentStatusNote = `\n\nPAYMENT STATUS: This customer has a PENDING payment claim (${paymentStatus.service || "unspecified"}, ₦${paymentStatus.amount || "unspecified"}) awaiting confirmation. If they ask about it, reassure them it's being checked and they'll get their receipt automatically once confirmed — don't create a new [PAYMENT_CLAIM] tag for this same one.`;
    } else if (paymentStatus.status === "confirmed") {
      paymentStatusNote = `\n\nPAYMENT STATUS: This customer's most recent payment (${paymentStatus.service || "unspecified"}, ₦${paymentStatus.amount || "unspecified"}) is CONFIRMED, receipt ${paymentStatus.receipt_number} was already sent. If they ask, let them know it's confirmed and their receipt was sent — don't create a new claim.`;
    }
  }

  const nigeriaTime = new Date().toLocaleString("en-US", {
    timeZone: "Africa/Lagos",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const fullContext = `${BUSINESS_CONTEXT}\n\nCURRENT PLATFORM: ${platform}\n\nCURRENT DATE/TIME IN NIGERIA: ${nigeriaTime}. Use this to greet appropriately (good morning/afternoon/evening/night) and never say something time-inappropriate like "have a great day" in the evening.${knownNameNote}${paymentStatusNote}\n\nLIVE WEBSITE CONTENT (most current info — prefer this over anything above if they conflict):\n${cachedWebsiteContent}`;

  const currentParts = [{ text: userMessage }];
  if (media) {
    currentParts.push({ inlineData: { mimeType: media.mimeType, data: media.base64Data } });
  }

  const contents = [
    ...convo.history,
    { role: "user", parts: currentParts },
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

  // Save this exchange — both to the fast in-process cache and persisted to
  // Supabase, so it survives a server restart
  convo.history.push({ role: "user", parts: [{ text: userMessage }] });
  convo.history.push({ role: "model", parts: [{ text: finalReply }] });
  convo.lastMessageTime = Date.now();
  await saveConversation(senderId, convo);

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
// ====== Track every message (both directions) so we can identify what's being quoted/replied to ======
const messageStore = new Map(); // WhatsApp message ID -> { text, time }

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of messageStore) {
    if (now - entry.time > 24 * 60 * 60 * 1000) messageStore.delete(id);
  }
}, 60 * 60 * 1000);

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
    return false;
  }

  const sentId = data.messages?.[0]?.id;
  if (sentId) messageStore.set(sentId, { text, time: Date.now() });

  console.log(`Reply sent to ${to}`);
  return true;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
