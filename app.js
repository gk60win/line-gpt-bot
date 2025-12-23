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

// LINE Webhook（署名検証のため raw で受ける）
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

// テニス関連かどうか（テキスト用の簡易判定）
function isRelatedToTennis(text) {
  const keywords = [
    "テニス", "フォアハンド", "バックハンド", "ストローク",
    "ボレー", "スマッシュ", "サーブ", "ラケット",
    "ストリング", "ガット", "トップスピン", "スライス",
    "リターン", "ダブルス", "シングルス"
  ];
  return keywords.some(keyword => text.includes(keyword));
}

// ユーザー識別キー
function getUserKey(event) {
  if (event.source.userId) return `user_${event.source.userId}`;
  if (event.source.groupId) return `group_${event.source.groupId}`;
  if (event.source.roomId) return `room_${event.source.roomId}`;
  return 'unknown';
}

// 「直前に動画を送ったかどうか」を覚える簡易フラグ
const lastVideoFlagByUser = {};
// （必要なら直前テキストも持てるようにしておく）
const lastTextByUser = {};

async function handleEvent(event) {
  if (event.type !== 'message') {
    return Promise.resolve(null);
  }

  const userKey = getUserKey(event);

  // ① 動画メッセージが来たとき
  if (event.message.type === 'video') {
    // 「直前に動画を送った」というフラグだけ立てておく
    lastVideoFlagByUser[userKey] = true;

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
        'サーブ（またはショット）の動画ありがとうございます！\n\n' +
        'このあと、テキストで「さっきアップしたサーブの動画から、だめな点を教えて」などのように、' +
        '悩みや見てほしいポイントを送ってください。'
    });
  }

  // ② テキストメッセージの場合
  if (event.message.type === 'text') {
    const userText = event.message.text || '';
    lastTextByUser[userKey] = userText;

    const hasRecentVideo = !!lastVideoFlagByUser[userKey];
    const refersToVideo = /動画|ビデオ|さっきアップした|さっき送った/.test(userText);

    // テニス関連か、または「動画に関するテニスの質問」とみなせるか
    const relatedToTennis =
      isRelatedToTennis(userText) || (hasRecentVideo && refersToVideo);

    if (!relatedToTennis) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text:
          'このBotはテニスに関する技術的な内容をサポートする専用です。\n' +
          '「サーブのフォームを見てほしい」「フォアハンドの安定感を上げたい」など、' +
          'テニスに関する質問や、さっき送ったテニス動画について質問してください。'
      });
    }

    // 直前に動画があり、かつ動画を参照しているテキスト => 「動画を見た前提」でアドバイス
    const isQuestionFromVideo = hasRecentVideo && refersToVideo;

    // ここで使うプロンプトを組み立て
    let userPrompt;

    if (isQuestionFromVideo) {
      userPrompt = `
ユーザーは直前にテニスの練習動画（特にサーブなど）をアップロードしたあと、次のように質問しています：

「${userText}」

あなたはその動画を見たテニスコーチである前提で、
1. フォーム（トス、構え、テイクバック、インパクト、フォロースルー、フットワークなど）
2. 戦術（コース選択、スピードと回転の配分、ポジショニングなど）

の観点から、問題になりやすいポイントと改善方法を、3〜5個ほど箇条書きで日本語でアドバイスしてください。

実際に動画は見えていなくても構いません。一般的によくあるミスやチェックポイントを踏まえて、
「ここをこうすると良い」という形で、できるだけ具体的にアドバイスしてください。
      `.trim();

      // 一度使ったらフラグを落としておく（古い動画にいつまでも引きずられないように）
      lastVideoFlagByUser[userKey] = false;
    } else {
      // 通常のテニス質問として扱う
      userPrompt = userText;
    }

    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content:
                'あなたは日本語で親切に答えるAIテニスコーチです。' +
                'フォームや戦術、メンタル、練習方法などについて、分かりやすく具体的にアドバイスしてください。\n' +
                'ユーザーが「さっきアップしたサーブの動画から、だめな点を教えて」など、' +
                '動画に言及した場合でも、動画を直接見られないからといって断らないでください。\n' +
                '動画は見えていない前提でも、一般的なサーブ・ストロークのチェックポイントや、' +
                'よくあるミスを想定しながら、改善方法を提案してください。\n' +
                '「動画を確認できない」「動画を見ることはできません」といった断り文句は使わず、' +
                '代わりに「チェックすべきポイント」と「どう直すか」を必ず提示してください。'
            },
            {
              role: 'user',
              content: userPrompt
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
        text: 'エラーが発生しました。時間をおいて再度お試しください。'
      });
    }
  }

  // 画像などその他のタイプはとりあえず無視
  return Promise.resolve(null);
}

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
