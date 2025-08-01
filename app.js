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

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'あなたは親切で知識豊富な日本語のAIアシスタントです。ユーザーの質問に簡潔に日本語で答えたあと、日本語の参考サイトURL（できれば日本の信頼できる情報源）を1つだけ末尾に付けてください。'
          },
          {
            role: 'user',
            content: event.message.text
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
