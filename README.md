# LINE GPT Bot - Multi URL & Smartphone Support

This bot replies only to IT-related questions (including smartphone issues).
If not related, it politely declines.

OpenAI GPT is used to respond, and up to 3 Japanese reference URLs are included.

## Setup

1. Upload this ZIP to Render
2. Set environment variables:
   - LINE_CHANNEL_ACCESS_TOKEN
   - LINE_CHANNEL_SECRET
   - OPENAI_API_KEY
3. Set your LINE webhook URL to:
   https://<your-app-name>.onrender.com/webhook
