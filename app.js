const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
require('dotenv').config();
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const sharp = require('sharp');
const { nanoid } = require('nanoid');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);
const app = express();

// ========= 設定 =========
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://line-gpt-bot-xdm0.onrender.com';
const OPENAI_MODEL_VISION = process.env.OPENAI_MODEL_VISION || 'gpt-4o-mini';

// フレーム切り出し設定：2秒に1枚×最大6枚（軽くして安定させる）
const FRAME_FPS = '1/2';
const MAX_FRAMES = 6;

// 一時アセット配信（/tmp は再起動で消える）
const ASSETS_DIR = '/tmp/assets';
fs.mkdirSync(ASSETS_DIR, { recursive: true });

// token -> filePath の簡易マップ（再起動で消えます）
const assetMap = new Map();

// ========= assets 配信 =========
// LINEに画像を返すため、HTTPSでアクセス可能なURLとして配信する
app.get('/assets/:token', (req, res) => {
  const token = req.params.token;
  const filePath = assetMap.get(token);
  if (!filePath || !fs.existsSync(filePath)) return res.sendStatus(404);
  res.sendFile(filePath);
});

function publishAsset(filePath) {
  const token = nanoid(18);
  assetMap.set(token, filePath);
  // 10分後に掃除
  setTimeout(() => assetMap.delete(token), 10 * 60 * 1000);
  return `${PUBLIC_BASE_URL}/assets/${token}`;
}

// ========= Webhook =========
// 署名検証のため raw で受ける
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

// ========= テニス判定（テキスト用） =========
function isRelatedToTennis(text) {
  if (!text) return false;
  const keywords = [
    "テニス", "フォア", "フォアハンド", "バック", "バックハンド", "ストローク",
    "ボレー", "スマッシュ", "サーブ", "リターン", "ラケット", "ガット", "ストリング",
    "トップスピン", "スライス", "ドロップ", "ロブ", "ダブルス", "シングルス",
    "トス", "回転", "コース", "戦術", "配球"
  ];
  return keywords.some(k => text.includes(k));
}

function getUserKey(event) {
  if (event.source.userId) return `user_${event.source.userId}`;
  if (event.source.groupId) return `group_${event.source.groupId}`;
  if (event.source.roomId) return `room_${event.source.roomId}`;
  return 'unknown';
}

// ========= 動画を保存 =========
async function downloadLineVideo(messageId) {
  const stream = await client.getMessageContent(messageId);
  const videoPath = path.join('/tmp', `${messageId}.mp4`);

  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(videoPath);
    stream.pipe(w);
    w.on('finish', resolve);
    w.on('error', reject);
  });

  return videoPath;
}

// ========= ffmpegでフレーム切り出し =========
async function extractFrames(videoPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const args = [
    '-i', videoPath,
    '-vf', `fps=${FRAME_FPS}`,
    '-frames:v', String(MAX_FRAMES),
    path.join(outDir, 'frame_%02d.jpg'),
    '-y'
  ];

  await new Promise((resolve, reject) => {
    execFile('ffmpeg', args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve();
    });
  });

  return fs.readdirSync(outDir)
    .filter(f => f.startsWith('frame_') && f.endsWith('.jpg'))
    .map(f => path.join(outDir, f));
}

function toDataUrl(jpgPath) {
  const b64 = fs.readFileSync(jpgPath).toString('base64');
  return `data:image/jpeg;base64,${b64}`;
}

// ========= OpenAIに「マーク座標＋助言」をJSONで返させる =========
async function getAnnotationsForFrame(jpgPath) {
  const schema = {
    name: "tennis_annotations",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        is_tennis: { type: "boolean" },
        shot_type: { type: "string", enum: ["serve","forehand","backhand","volley","unknown"] },
        notes: { type: "string" },
        marks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { type: "string" },
              severity: { type: "string", enum: ["low","mid","high"] },
              x: { type: "number" }, // 0..1
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" },
              advice: { type: "string" }
            },
            required: ["label","severity","x","y","w","h","advice"]
          }
        }
      },
      required: ["is_tennis","shot_type","notes","marks"]
    }
  };

  const resp = await axios.post(
    'https://api.openai.com/v1/responses',
    {
      model: OPENAI_MODEL_VISION,
      input: [{
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              "あなたはテニス専門コーチ。画像がテニスでない場合 is_tennis=false。テニスなら、フォーム改善で指摘すべき箇所を最大3つ選び、座標(x,y,w,h)を0〜1で返す。labelは短く、adviceは具体的に。"
          },
          { type: 'input_image', image_url: toDataUrl(jpgPath) }
        ]
      }],
      response_format: { type: "json_schema", json_schema: schema }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  // Structured Outputなら output_text がJSON文字列として返る想定
  const text = resp.data.output_text;
  return JSON.parse(text);
}

// ========= 画像にマークを描く（SVG合成） =========
async function drawMarks(jpgPath, annotations) {
  const img = sharp(jpgPath);
  const meta = await img.metadata();
  const W = meta.width;
  const H = meta.height;

  const marks = (annotations.marks || []).slice(0, 3);

  const boxesSvg = marks.map((m, i) => {
    const x = Math.max(0, Math.min(W - 1, Math.round(m.x * W)));
    const y = Math.max(0, Math.min(H - 1, Math.round(m.y * H)));
    const w = Math.max(1, Math.min(W - x, Math.round(m.w * W)));
    const h = Math.max(1, Math.min(H - y, Math.round(m.h * H)));
    const n = i + 1;

    // 枠＋番号（赤）
    return `
      <rect x="${x}" y="${y}" width="${w}" height="${h}"
            fill="none" stroke="#ff0000" stroke-width="6"/>
      <circle cx="${x + 22}" cy="${y + 22}" r="20" fill="#ff0000"/>
      <text x="${x + 15}" y="${y + 30}" font-size="24" fill="#ffffff" font-family="sans-serif">${n}</text>
    `;
  }).join("\n");

  const svg = Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${boxesSvg}
    </svg>
  `);

  const outPath = path.join(ASSETS_DIR, `${nanoid(16)}.jpg`);
  await img
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toFile(outPath);

  return { outPath, marks };
}

// ========= 直近動画の解析メモ（後続質問に使う） =========
const lastAnalysisByUser = {}; // userKey -> { at, shot_type, notes, tipsText }

function buildTipsText(marks) {
  if (!marks || marks.length === 0) return "改善ポイントを抽出できませんでした。";
  return marks.map((m, i) => `${i + 1}. ${m.label}：${m.advice}`).join("\n");
}

// ========= メイン処理 =========
async function handleEvent(event) {
  if (event.type !== 'message') return Promise.resolve(null);

  const userKey = getUserKey(event);

  // --- 動画が来たら「即」解析して返す（画像付き） ---
  if (event.message.type === 'video') {
    try {
      const videoPath = await downloadLineVideo(event.message.id);
      const framesDir = path.join('/tmp', `frames_${event.message.id}`);
      const frames = await extractFrames(videoPath, framesDir);

      if (frames.length === 0) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '動画からフレームを抽出できませんでした。別の動画で再度お試しください。'
        });
      }

      // 代表フレームを2枚だけ解析＆マーク（コストと速度のため）
      const pick = frames.slice(0, 2);

      const markedUrls = [];
      const allTips = [];

      // まず1枚目で「テニスかどうか」判定＆指摘
      const ann0 = await getAnnotationsForFrame(pick[0]);
      if (!ann0.is_tennis) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: 'テニスに関係ない動画のため、返答できません。'
        });
      }

      // 1枚目マーク
      const drawn0 = await drawMarks(pick[0], ann0);
      const url0 = publishAsset(drawn0.outPath);
      markedUrls.push(url0);
      allTips.push(buildTipsText(drawn0.marks));

      // 2枚目も可能なら解析
      if (pick[1]) {
        const ann1 = await getAnnotationsForFrame(pick[1]);
        // テニス以外判定になっても、1枚目がテニスなら続行（撮影ブレ対策）
        if (ann1.is_tennis) {
          const drawn1 = await drawMarks(pick[1], ann1);
          const url1 = publishAsset(drawn1.outPath);
          markedUrls.push(url1);
          allTips.push(buildTipsText(drawn1.marks));
        }
      }

      // 直近解析を保存（後続質問に利用）
      lastAnalysisByUser[userKey] = {
        at: Date.now(),
        shot_type: ann0.shot_type,
        notes: ann0.notes,
        tipsText: allTips.join("\n\n")
      };

      // LINEに返信（画像1〜2枚 + テキスト）
      const messages = [];

      // 画像（最大2枚）
      for (const u of markedUrls.slice(0, 2)) {
        messages.push({
          type: 'image',
          originalContentUrl: u,
          previewImageUrl: u
        });
      }

      // テキスト（番号の意味）
      messages.push({
        type: 'text',
        text:
          `改善ポイント（画像の番号に対応）\n` +
          `${lastAnalysisByUser[userKey].tipsText}\n\n` +
          `追加で「サーブを安定させたい」「回転量を増やしたい」など目的を送ってください。直近の動画を前提に再アドバイスします。`
      });

      return client.replyMessage(event.replyToken, messages);

    } catch (error) {
      console.error('Video analyze error:', error);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '解析中にエラーが発生しました。動画を短くして再送するか、時間をおいて再度お試しください。'
      });
    }
  }

  // --- テキスト質問：直近動画の解析結果を前提に再アドバイス ---
  if (event.message.type === 'text') {
    const userText = event.message.text || '';

    // テニス以外はお断り（要件通り）
    if (!isRelatedToTennis(userText)) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'テニスに関係ない内容のため、返答できません。'
      });
    }

    const last = lastAnalysisByUser[userKey];
    if (!last) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '先にフォーム動画を送ってください。フレームにマークを付けて改善点を返します。'
      });
    }

    try {
      const prompt = `
あなたは日本語のAIテニスコーチ。
直近の動画解析メモ（番号付き改善点）：
${last.tipsText}

補足メモ：
ショット種別: ${last.shot_type}
所感: ${last.notes}

ユーザー質問：
「${userText}」

この解析メモを前提に、改善アドバイスを3〜5個（箇条書き）＋練習ドリルを2つ提案して。
`.trim();

      const resp = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'あなたは日本語で親切に答えるAIテニスコーチです。具体的に。' },
            { role: 'user', content: prompt }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const reply = resp.data.choices[0].message.content.trim();
      return client.replyMessage(event.replyToken, { type: 'text', text: reply });

    } catch (error) {
      console.error('Follow-up error:', error);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '再アドバイス生成中にエラーが発生しました。'
      });
    }
  }

  // 画像など他のタイプは案内だけ
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: 'テニスの動画（mp4）を送ってください。フレームにマークを付けて改善点を返します。'
  });
}

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server is running on port ${port}`));
