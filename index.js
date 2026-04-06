require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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
    systemPrompt: `You are an AI customer service agent for a business. You are helpful, friendly, and professional. You answer questions about the business, help book appointments, take orders, and handle customer inquiries 24/7. If you do not know something specific about the business, be honest and offer to have a human follow up. Always be concise — WhatsApp messages should be short and conversational, not long paragraphs. Never use markdown formatting like asterisks or hashtags — plain text only for WhatsApp.`,
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
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
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
