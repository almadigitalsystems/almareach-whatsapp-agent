require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.set('trust proxy', 1); // Trust Railway's reverse proxy

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory conversation history: key = from phone number
const conversations = new Map();
const MAX_HISTORY = 10;

// Business hours: 8am–6pm EST Mon–Fri
function isBusinessHours() {
  const now = new Date();
  const est = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = est.getDay(); // 0=Sun, 6=Sat
  const hour = est.getHours();
  return day >= 1 && day <= 5 && hour >= 8 && hour < 18;
}

// Client configs by Twilio WhatsApp number
const CLIENTS = {
  [process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+18666655001']: {
    name: 'AlmaReach',
    systemPrompt: `You are Alex, a friendly sales and support rep for Alma Digital Services. Warm, sharp, conversational like a knowledgeable friend, never a robot. You text like a real person: casual, confident, concise. LANGUAGE: Auto-detect. Spanish in = Spanish out. English in = English out. Never mix. FORMATTING: Plain text only. No asterisks, no bullets, no markdown. Max 3-4 sentences per message. Never start with I, Great!, Of course!, or Absolutely!. WHO WE ARE: Alma Digital Services, Miami FL. AI-powered websites for small businesses. Every client sees a FREE custom preview before paying. same-day delivery. No contracts. PRODUCTS: Websites (pay once own forever, free domain, free preview, up to 3 revisions on the free preview before payment): Starter \$50 up to 5 pages, Growth \$100 up to 10 pages plus SEO blog analytics, Premium \$150 20+ pages animations booking CRO. Add hosting (cancel anytime, includes SSL backups security priority support): Starter+hosting \$50+\$17/mo, Growth+hosting \$100+\$23/mo, Premium+hosting \$150+\$23/mo. Google Presence Kit \$49 one-time: done-for-you Google Business Profile package with custom photos, description, 5 Google Posts, review templates, setup guide, 30-45 min to upload. Care Plan \$29/mo add-on: monthly updates, security monitoring, backups, reports, priority support. PAYMENT LINKS (send exact URL when closing): Starter only https://buy.stripe.com/eVq9AScgK0mih31eyn6Zy0b, Growth only https://buy.stripe.com/aFafZg80u2uq287gGv6Zy0c, Premium only https://buy.stripe.com/eVqbJ03Ke1qmh3161R6Zy0d, Starter+hosting https://buy.stripe.com/6oUdR8a8C2uqh31eyn6Zy0e, Growth+hosting https://buy.stripe.com/9B6bJ01C67OKdQPfCr6Zy0f, Premium+hosting https://buy.stripe.com/aFafZg6Wqed8143bmb6Zy0g, Google Kit https://buy.stripe.com/28E14m2Gac50dQPeyn6Zy0k. Logo Only ($25) https://buy.stripe.com/aFa00ibcG5GC5kjeyn6Zy0A, Brand Starter ($50) https://buy.stripe.com/3cI9AScgK1qmcMLbmb6Zy0B, Full Brand Identity ($100) https://buy.stripe.com/6oUbJ0dkO9WSeUT9e36Zy0C. SALES PIPELINE: Stage 1 QUALIFY find out their business type and if they have a website, one casual question at a time. Stage 2 PITCH PREVIEW once you know their business say we can build you a free preview so you see it before paying anything, want me to set that up? Get business name and what they do. Stage 3 HANDLE QUESTIONS answer pricing honestly, push value: free domain same-day delivery free preview no contracts, recommend hosting for non-tech people. Stage 4 CLOSE send right Stripe link, say here is your payment link for [plan] [URL] once done we start right away site ready same day. Stage 5 POST-PAYMENT say perfect we are on it, ready same day, our team will reach out with next steps. CLIENT SUPPORT: For existing clients answer questions about timelines pricing and what is included directly. For account-specific issues like order status billing or live site problems say you will flag it for the team and they will follow up shortly. COMMON QA: Free preview means real custom site real design real content you see it before paying anything. Keep my domain yes share it and we connect it free. Templates never built specifically for your business. No website yet domain included free on all plans. Google means Google Presence Kit \$49 done for you. How long preview same day live site same day after payment. Changes up to 3 revisions on your free preview before you pay — more than enough to get it exactly right. Care Plan covers updates after launch. ALWAYS end with something that moves things forward a question a next step or an offer.`,
  },
  // Add 247Clerk number here when available:
  // 'whatsapp:+1XXXXXXXXXX': {
  //   name: '247Clerk',
  //   systemPrompt: '...',
  // },
};

const DEFAULT_CLIENT = Object.values(CLIENTS)[0];

function getClient(toNumber) {
  return CLIENTS[toNumber] || DEFAULT_CLIENT;
}

// Human handoff keywords
const HANDOFF_KEYWORDS = ['speak to someone', 'human', 'agent', 'speak to a person', 'talk to someone', 'real person'];

function isHandoffRequest(text) {
  const lower = text.toLowerCase().trim();
  return HANDOFF_KEYWORDS.some(kw => lower.includes(kw));
}

async function sendHandoffEmail(from, conversationHistory) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.NOTIFICATION_EMAIL,
      pass: process.env.NOTIFICATION_EMAIL_PASSWORD,
    },
  });

  const historyText = conversationHistory
    .map(m => `${m.role === 'user' ? 'Customer' : 'Bot'}: ${m.content}`)
    .join('\n');

  await transporter.sendMail({
    from: process.env.NOTIFICATION_EMAIL,
    to: process.env.NOTIFICATION_EMAIL,
    subject: `Human handoff requested from ${from}`,
    text: `A customer requested to speak to a human.\n\nPhone: ${from}\n\nConversation history:\n${historyText}`,
  }).catch(err => {
    console.error('[email] Failed to send handoff email:', err.message);
  });
}

async function getClaudeResponse(client, conversationHistory, incomingMessage) {
  const messages = [
    ...conversationHistory,
    { role: 'user', content: incomingMessage },
  ];

  const afterHoursPrefix = !isBusinessHours()
    ? 'Note: it is currently after business hours, but I am still here to help. '
    : '';

  const systemPrompt = afterHoursPrefix + client.systemPrompt;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: systemPrompt,
    messages,
  });

  return response.content[0].text;
}

// Validate Twilio webhook signature
function validateTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return true; // skip in dev if not set
  const signature = req.headers['x-twilio-signature'];
  if (!signature) return false;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const url = `${protocol}://${req.get('host')}${req.originalUrl}`;
  return twilio.validateRequest(authToken, signature, url, req.body);
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'almareach-whatsapp-agent', timestamp: new Date().toISOString() });
});

app.post('/whatsapp/webhook', async (req, res) => {
  // Validate Twilio signature in production
  if (process.env.NODE_ENV === 'production' && !validateTwilioSignature(req)) {
    console.warn('[security] Invalid Twilio signature rejected');
    return res.status(403).send('Forbidden');
  }

  const from = req.body.From;       // e.g. whatsapp:+447911123456
  const to = req.body.To;           // our WhatsApp number
  const body = req.body.Body || '';

  if (!from || !body) {
    return res.status(200).send('<Response></Response>');
  }

  console.log(`[in] ${from} -> ${to}: ${body}`);

  const client = getClient(to);
  const history = conversations.get(from) || [];

  const twiml = new twilio.twiml.MessagingResponse();

  // Handle human handoff
  if (isHandoffRequest(body)) {
    console.log(`[handoff] ${from} requested human agent`);
    await sendHandoffEmail(from, history);
    twiml.message('No problem! A member of our team will be in touch with you shortly. Our business hours are Monday to Friday, 8am to 6pm EST.');
    return res.type('text/xml').send(twiml.toString());
  }

  // Add user message to history
  history.push({ role: 'user', content: body });
  if (history.length > MAX_HISTORY) history.shift();

  let replyText;
  try {
    replyText = await getClaudeResponse(client, history.slice(0, -1), body);
  } catch (err) {
    console.error('[claude] API error:', err.message);
    replyText = 'Sorry, I am having trouble right now. Please try again in a moment or contact us directly.';
  }

  // Add assistant response to history
  history.push({ role: 'assistant', content: replyText });
  if (history.length > MAX_HISTORY * 2) history.splice(0, 2); // trim oldest pair

  conversations.set(from, history);

  console.log(`[out] -> ${from}: ${replyText}`);

  twiml.message(replyText);
  res.type('text/xml').send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] almareach-whatsapp-agent listening on port ${PORT}`);
  console.log(`[server] Webhook endpoint: POST /whatsapp/webhook`);
  console.log(`[server] Health check: GET /health`);
});
