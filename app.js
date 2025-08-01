const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const axios = require('axios');

const app = express();

// 環境変数から設定を取得
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const openaiApiKey = process.env.OPENAI_API_KEY;
const client = new Client(config);

// LINE SDK middleware（署名検証）を先に通す！ express.json()は不要
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Error in /webhook handler:', err);
    res.status(500).end();
  }
});

// イベントハンドラー
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const userMessage = event.message.text;

  // ChatGPTに問い合わせ
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo', // または 'gpt-4'
        messages
