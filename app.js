const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
require('dotenv').config();
const bodyParser = require('body-parser');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);
const app = express();

// LINEの署名検証のため、生のボディを扱う
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

// テニス関連かどうか判定（テキスト用）
function isRelatedToTennis(text) {
  const keywords = [
    "テニス", "フォアハンド", "バックハンド", "ストローク",
    "ボレー", "スマッシュ", "サーブ", "ラケット",
    "ストリング", "トップスピン", "スライス", "リターン",
    "ダブルス", "シングルス"
  ];
  return keywords.some(keyword => text.includes(keyword));
}

// ユーザーごとの「直前のテキスト」を保存する簡易メモリ
// key: userId / groupId / roomId
const lastTextByUser = {};

// ユーザー識別用キーを作るヘルパー
function getUserKey(event) {
  if (event.source.userId) return `user_${event.source.userId}`;
  if (event.source.groupId) return `group_${event.source.groupId}`;
  if (event.source.roomId) return `room_${event.source.roomId}`;
  return 'unknown';
}

async function handleEvent(event) {
  if (event.type !== 'message') {
    return Promise.resolve(null);
  }

  const userKey = getUserKey(event);

  // ① 動画メッセージの処理
  if (event.message.type === 'video') {
    const contextText = lastTextByUser[userKey] || '';

    // 直前テキストがない / テニスと関係なさそうならお断り
    if (!contextText || !isRelatedToTennis(contextText)) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'テニスに関係する動画か判定できませんでした。\n\n動画を送る前に、「フォアハンドのフォームです」「試合のリターンゲームです」など、テニスに関する簡単な説明をテキストで送ってから、もう一度動画を送ってください。'
      });
    }

    // テニス動画っぽいと判断できた場合：
    // ※ 実際の映像はAPIで直接解析できないため、
    //   「このような動画が送られてきた」という説明文を元に
    //   フォーム／戦術アドバイスを生成する。
    try {
      const prompt = `
ユーザーからテニスの練習動画が送られてきました。
実際の映像は見えませんが、動画の内容は次のテキストで説明されています：

「${contextText}」

この説明から想像できる範囲で構わないので、
1. 現状のフォームで改善すべき箇所とだめな理由（準備、テイクバック、インパクト、フォロースルーなど）
2. その改善方法

について、日本語で具体的なアドバイスを3〜5個にまとめてください。
各アドバイスは「見てあげるポイント → 改善方法」の順で、短い箇条書き形式でお願いします。
      `.trim();

      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: 'あなたは日本語で親切に答えるAIテニスコーチです。フォームや戦術をわかりやすくアドバイスしてください。'
            },
            {
              role: 'user',
              content: prompt
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
      console.error('Error from OpenAI (video flow):', error.message);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '動画に基づくアドバイスの生成中にエラーが発生しました。時間をおいて再度お試しください。'
      });
    }
  }

  // ② テキストメッセージの処理
  if (event.message.type === 'text') {
    const userText = event.message.text || '';

    // 直前テキストとして保存（次に動画が来たときの「動画の説明」として使う）
    lastTextByUser[userKey] = userText;

    // テニスに関係していないテキストはお断り
    if (!isRelatedToTennis(userText)) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'このBotはテニスに関する技術的な内容のみお答えします。\n「フォアハンドのフォームを見てほしい」「サーブのトスが安定しない」など、テニスに関する質問を送ってください。'
      });
    }

    // テニスに関するテキスト質問 → 通常のGPT回答
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: 'あなたは日本語で親切に答えるAIテニスコーチです。テニスに関する質問やお悩みに、フォームや戦術の観点からわかりやすくアドバイスしてください。'
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
      console.error('Error from OpenAI (text flow):', error.message);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'エラーが発生しました。時間をおいて再度お試しください。'
      });
    }
  }

  // それ以外のメッセージ種別（画像など）は無視
  return Promise.resolve(null);
}

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
