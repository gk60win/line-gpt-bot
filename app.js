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

// =====================
// 設定
// =====================
const MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
// 「直近動画」とみなす時間（例：2時間）
const LAST_VIDEO_TTL_MS = 2 * 60 * 60 * 1000;

// =====================
// 署名検証のため raw ボディで受ける
// =====================
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

// =====================
// テニス関連判定（ざっくり）
// =====================
function isRelatedToTennis(text) {
  if (!text) return false;
  const keywords = [
    "テニス", "フォア", "フォアハンド", "バック", "バックハンド", "ストローク",
    "ボレー", "スマッシュ", "サーブ", "リターン", "ラケット", "ガット", "ストリング",
    "トップスピン", "スライス", "ドロップ", "ロブ", "ダブルス", "シングルス",
    "サービス", "ファースト", "セカンド", "トス", "回転", "コース", "戦術", "配球"
  ];
  return keywords.some(k => text.includes(k));
}

// 「動画について質問してる」っぽい文言
function refersToVideo(text) {
  if (!text) return false;
  return /動画|ビデオ|さっき|前の|アップした|送った/.test(text);
}

// =====================
// ユーザー識別キー
// =====================
function getUserKey(event) {
  if (event.source.userId) return `user_${event.source.userId}`;
  if (event.source.groupId) return `group_${event.source.groupId}`;
  if (event.source.roomId) return `room_${event.source.roomId}`;
  return 'unknown';
}

// =====================
// メモリ（Render再起動で消えます。永続化したいならDBへ）
// =====================
/**
 * lastVideoByUser[userKey] = {
 *   messageId: string,
 *   receivedAt: number,
 *   lastAdviceText: string | null
 * }
 */
const lastVideoByUser = {};
const lastTextByUser = {};

// =====================
// OpenAI 呼び出し（Chat Completions）
// =====================
async function askCoach(messages) {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model: MODEL, messages },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      }
    }
  );
  return response.data.choices[0].message.content.trim();
}

// =====================
// 動画を受け取った直後に返す “即アドバイス”
// =====================
async function makeInstantAdvice() {
  // 動画内容が分からなくても「まず返す」ための汎用アドバイス
  const prompt = `
ユーザーがテニスの動画（フォーム確認用）をアップしました。
あなたは日本語のAIテニスコーチです。

要件：
- すぐに役立つ「チェックポイント→直し方」を 5個、箇条書きで出す
- サーブ/ストローク/ボレーなど種類が不明なので、共通の重要点（準備・打点・体重移動・脱力・フットワーク等）を中心に
- 最後に「動画は サーブ/フォア/バック/ボレー/試合 のどれですか？」のように、種類を1問だけ聞く（短く）
- 「見れない」「確認できない」などの断り文句は書かない
`.trim();

  return askCoach([
    {
      role: 'system',
      content:
        'あなたは日本語で親切に答えるAIテニスコーチです。短く具体的に。断り文句は禁止。'
    },
    { role: 'user', content: prompt }
  ]);
}

// =====================
// 動画に紐づけて再アドバイス（テキスト質問が来たとき）
// =====================
async function makeFollowupAdvice({ userQuestion, lastAdviceText }) {
  const prompt = `
ユーザーは直前にテニスのフォーム動画をアップし、その後に質問しています。

直前にあなたが返した初回アドバイス（参考）：
${lastAdviceText ? `「${lastAdviceText}」` : '（初回アドバイスは未保存）'}

ユーザーの質問：
「${userQuestion}」

あなたは「その動画を見たコーチ」という前提で、質問に答えつつ、必要なら補足の改善案を 3〜5個、箇条書きで提示してください。
- 断り文句（見れない/確認できない等）は禁止
- 具体的な練習ドリル（例：トス位置固定、影打ち、球出しの回数/意識）も1〜2個入れる
- 最後に追加で確認したいことがあれば、短い質問を最大2つまで
`.trim();

  return askCoach([
    {
      role: 'system',
      content:
        'あなたは日本語で親切に答えるAIテニスコーチです。短く具体的に。断り文句は禁止。'
    },
    { role: 'user', content: prompt }
  ]);
}

// =====================
// メインハンドラ
// =====================
async function handleEvent(event) {
  if (event.type !== 'message') {
    return Promise.resolve(null);
  }

  const userKey = getUserKey(event);

  // ---- 動画が来たら「すぐ返す」 ----
  if (event.message.type === 'video') {
    // 受信した動画を記憶
    lastVideoByUser[userKey] = {
      messageId: event.message.id,
      receivedAt: Date.now(),
      lastAdviceText: null
    };

    try {
      const advice = await makeInstantAdvice();

      // 初回アドバイスを保存（後続の質問で参照）
      lastVideoByUser[userKey].lastAdviceText = advice;

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: advice
      });
    } catch (error) {
      console.error('Error from OpenAI (instant video advice):', error.message);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '動画の解析中にエラーが発生しました。時間をおいて再度お試しください。'
      });
    }
  }

  // ---- テキストが来たら ----
  if (event.message.type === 'text') {
    const userText = event.message.text || '';
    lastTextByUser[userKey] = userText;

    const tennis = isRelatedToTennis(userText);
    const videoRef = refersToVideo(userText);

    // 直近動画があるか（TTL内）
    const lastVideo = lastVideoByUser[userKey];
    const hasFreshVideo =
      lastVideo && (Date.now() - lastVideo.receivedAt) <= LAST_VIDEO_TTL_MS;

    // テニス以外はお断り（要件どおり）
    // ※「さっきの動画〜」でも、テニス単語が一切ないと誤判定するので、
    //    “直近動画があり、動画参照っぽい”ならテニス扱いにする
    const treatAsTennis = tennis || (hasFreshVideo && videoRef);

    if (!treatAsTennis) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'テニスに関係ない内容のため、返答できません。テニスのフォームや戦術に関する質問を送ってください。'
      });
    }

    // 直近動画があるなら「動画前提で再アドバイス」
    if (hasFreshVideo) {
      try {
        const followup = await makeFollowupAdvice({
          userQuestion: userText,
          lastAdviceText: lastVideo.lastAdviceText
        });

        // 追記アドバイスも保存しておく（次の質問で参照）
        lastVideoByUser[userKey].lastAdviceText = followup;

        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: followup
        });
      } catch (error) {
        console.error('Error from OpenAI (followup):', error.message);
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: 'アドバイス生成中にエラーが発生しました。時間をおいて再度お試しください。'
        });
      }
    }

    // 直近動画がない場合は「通常のテニス質問」として回答
    try {
      const reply = await askCoach([
        {
          role: 'system',
          content:
            'あなたは日本語で親切に答えるAIテニスコーチです。短く具体的に。断り文句は禁止。'
        },
        { role: 'user', content: userText }
      ]);

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: reply
      });
    } catch (error) {
      console.error('Error from OpenAI (text):', error.message);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'エラーが発生しました。時間をおいて再度お試しください。'
      });
    }
  }

  // それ以外のメッセージ（画像など）
  return Promise.resolve(null);
}

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
