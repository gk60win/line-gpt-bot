const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();
const bodyParser = require('body-parser');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);
const app = express();

app.post('/webhook', bodyParser.raw({ type: '*/*' }), (req, res) => {
  const signature = req.headers['x-line-signature'];
  const body = req.body;

  if (!line.validateSignature(body, config.channelSecret, signature)) {
    return res.status(401).send('Unauthorized');
  }

  const parsedBody = JSON.parse(body.toString());

  Promise.all(parsedBody.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => {
      console.error(err);
      res.status(500).end();
    });
});

function isRelatedToITSupport(text) {
  const keywords = [
    "パソコン", "Wi-Fi", "インターネット", "ネットワーク", "プリンタ", "メール", "Outlook",
    "Teams", "アカウント", "パスワード", "セキュリティ", "Zoom", "VPN", "共有フォルダ", "システム", "PC"
  ];
  return keywords.some(keyword => text.includes(keyword));
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userText = event.message.text;

  if (!isRelatedToITSupport(userText)) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '情シス業務とは異なるご質問のため、ご返答できません。ご了承ください。'
    });
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'あなたは日本語で親切に答えるAIです。回答のあとに、日本語の一般的な参考サイト（.jp や .com などを含む）から、適切なURLを最大3つまで添えてください。'
          },
          {
            role: 'user',
            content: userText
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    const gptReply = response.data.choices[0].message.content.trim();
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: gptReply
    });
  } catch (error) {
    console.error('Error from OpenAI:', error.message);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'エラーが発生しました。'
    });
  }
}

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
