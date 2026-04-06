# AlmaReach WhatsApp AI Agent

WhatsApp AI agent powered by **Twilio** + **Claude API** (Anthropic). Handles customer inquiries for AlmaReach and 247Clerk 24/7.

## Features

- Receives WhatsApp messages via Twilio webhook at `POST /whatsapp/webhook`
- Responds using Claude Sonnet with per-client system prompts
- Maintains last 10 messages of conversation history per user
- Human handoff when user says "human", "agent", or "speak to someone"
  - Sends notification email to `NOTIFICATION_EMAIL`
- Business hours awareness (8am–6pm EST Mon–Fri)
- Twilio webhook signature verification (production)
- Multi-client support (AlmaReach + 247Clerk)

## Environment Variables

| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
| `TWILIO_WHATSAPP_NUMBER` | Your WhatsApp number e.g. `whatsapp:+18666655001` |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `NOTIFICATION_EMAIL` | Email for human handoff alerts |
| `NOTIFICATION_EMAIL_PASSWORD` | Gmail app password for SMTP |
| `NODE_ENV` | Set to `production` on Railway |
| `PORT` | Port (Railway sets this automatically) |

## Deployment (Railway)

1. Connect this repo to a new Railway service
2. Add all environment variables above in Railway dashboard
3. Railway will auto-deploy on push
4. Copy the Railway public URL (e.g. `https://almareach-whatsapp-agent-production.up.railway.app`)

## Twilio Webhook Configuration

1. Go to [Twilio Console](https://console.twilio.com) → Messaging → Senders → WhatsApp Senders
2. Select `+18666655001`
3. Set webhook URL to: `https://<railway-url>/whatsapp/webhook`
4. Method: `HTTP POST`

## Local Development

```bash
cp .env.example .env
# Fill in your credentials
npm install
npm run dev
# Use ngrok to expose local port for Twilio testing:
# ngrok http 3000
```

## Health Check

`GET /health` — returns `{ status: 'ok', ... }`

## Adding 247Clerk Client

In `index.js`, uncomment the `247Clerk` entry in the `CLIENTS` object and set the correct WhatsApp number + system prompt.
