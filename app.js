const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
require("dotenv").config();
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const sharp = require("sharp");
const { nanoid } = require("nanoid");

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

// ========= 設定 =========
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // 例: https://xxxxx.onrender.com
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// 画像解析（Vision）対応モデル
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
// テキスト回答モデル（軽く）
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";

// フレーム切り出し（軽量・安定重視）
const FPS_FILTER = "fps=1,scale=384:-2";
const MAX_FRAMES = 2; // 最大2枚
const VIDEO_ANALYZE_SECONDS = 15; // ★最初の8秒だけ解析（負荷削減）

// 一時アセット配信用（Renderでは /tmp が使える）
const ASSETS_DIR = "/tmp/assets";
fs.mkdirSync(ASSETS_DIR, { recursive: true });

// ========= /assets 配信（Map廃止・静的配信） =========
// これでプロセス再起動しても「ファイルが残っている限り」画像URLが生きる
app.use(
  "/assets",
  express.static(ASSETS_DIR, {
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "public, max-age=300");
    },
  })
);

// ========= 署名検証のため raw body =========
app.post("/webhook", bodyParser.raw({ type: "*/*" }), (req, res) => {
  const signature = req.headers["x-line-signature"];
  const body = req.body;

  if (!line.validateSignature(body, config.channelSecret, signature)) {
    return res.status(401).send("Unauthorized");
  }

  const parsedBody = JSON.parse(body.toString());
  Promise.all(parsedBody.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// ========= ユーザー/グループ宛先 =========
function getTargetId(event) {
  if (event.source.userId) return event.source.userId;
  if (event.source.groupId) return event.source.groupId;
  if (event.source.roomId) return event.source.roomId;
  return null;
}

function getMemoryKey(event) {
  if (event.source.userId) return `user_${event.source.userId}`;
  if (event.source.groupId) return `group_${event.source.groupId}`;
  if (event.source.roomId) return `room_${event.source.roomId}`;
  return `unknown`;
}

// ========= テニス判定（テキスト用） =========
function isRelatedToTennis(text) {
  if (!text) return false;
  const keywords = [
    "テニス",
    "サーブ",
    "フォア",
    "フォアハンド",
    "バック",
    "バックハンド",
    "ボレー",
    "スマッシュ",
    "ストローク",
    "スライス",
    "トップスピン",
    "回転",
    "打点",
    "トス",
    "戦術",
    "配球",
    "リターン",
    "ラケット",
    "ガット",
  ];
  return keywords.some((k) => text.includes(k));
}

// ========= 動画を保存（LINEからダウンロード） =========
async function downloadLineVideo(messageId) {
  const stream = await client.getMessageContent(messageId);
  const videoPath = path.join("/tmp", `${messageId}.mp4`);

  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(videoPath);
    stream.pipe(w);
    w.on("finish", resolve);
    w.on("error", reject);
  });

  return videoPath;
}

// ========= ffmpegでフレーム切り出し（最初のN秒だけ） =========
async function extractFrames(videoPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const args = [
    "-ss",
    "0",
    "-t",
    String(VIDEO_ANALYZE_SECONDS), // ★最初のN秒に限定
    "-i",
    videoPath,
    "-vf",
    FPS_FILTER,
    "-frames:v",
    String(MAX_FRAMES),
    "-q:v",
    "4",
    path.join(outDir, "frame_%02d.jpg"),
    "-y",
  ];

  await new Promise((resolve, reject) => {
    execFile("ffmpeg", args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve();
    });
  });

  return fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith("frame_") && f.endsWith(".jpg"))
    .map((f) => path.join(outDir, f));
}

// ★OpenAIに送る前に画像を縮小して軽くする（メモリ・速度改善）
async function makeSmallForAI(jpgPath) {
  const outPath = path.join("/tmp", `${nanoid(12)}_ai.jpg`);
  await sharp(jpgPath)
    .resize({ width: 512, withoutEnlargement: true }) // ★横512に縮小
    .jpeg({ quality: 75 })
    .toFile(outPath);
  return outPath;
}

function toDataUrl(jpgPath) {
  const b64 = fs.readFileSync(jpgPath).toString("base64");
  return `data:image/jpeg;base64,${b64}`;
}

// ========= OpenAIで「テニスか判定＋マーク座標＋助言」をJSONで返させる =========
async function analyzeFrameWithOpenAI(jpgPath) {
  const prompt = `
あなたはテニス専門コーチです。
入力画像がテニス動画のフレームでない場合は is_tennis=false にしてください。
テニスの場合、フォーム改善の指摘箇所を最大3つに絞り、画像上の矩形を0〜1の相対座標で返してください。
必ず「JSONのみ」で返してください（コードブロック禁止）。

出力JSON形式:
{
  "is_tennis": true/false,
  "shot_type": "serve"|"forehand"|"backhand"|"volley"|"unknown",
  "notes": "短い所感",
  "marks": [
    {"label":"短い名称","severity":"low"|"mid"|"high","x":0.1,"y":0.2,"w":0.2,"h":0.2,"advice":"具体的改善"}
  ]
}
`.trim();

  // ★AIへ送る画像は縮小版
  const smallPath = await makeSmallForAI(jpgPath);

  const resp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: OPENAI_VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: toDataUrl(smallPath) } },
          ],
        },
      ],
      temperature: 0.2,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 120000,
    }
  );

  // 使い終わった縮小ファイルは削除（/tmp肥大化防止）
  try {
    fs.unlinkSync(smallPath);
  } catch {}

  const content = resp.data?.choices?.[0]?.message?.content || "";
  const jsonText = content.match(/\{[\s\S]*\}/)?.[0] || "";
  return JSON.parse(jsonText);
}

// ========= 画像に赤枠＋番号を描画 =========
async function drawMarks(jpgPath, marks) {
  const img = sharp(jpgPath);
  const meta = await img.metadata();
  const W = meta.width;
  const H = meta.height;

  const picked = (marks || []).slice(0, 3);

  const boxesSvg = picked
    .map((m, i) => {
      const x = Math.max(0, Math.min(W - 1, Math.round(m.x * W)));
      const y = Math.max(0, Math.min(H - 1, Math.round(m.y * H)));
      const w = Math.max(1, Math.min(W - x, Math.round(m.w * W)));
      const h = Math.max(1, Math.min(H - y, Math.round(m.h * H)));
      const n = i + 1;

      return `
        <rect x="${x}" y="${y}" width="${w}" height="${h}"
              fill="none" stroke="#ff0000" stroke-width="6"/>
        <circle cx="${x + 22}" cy="${y + 22}" r="20" fill="#ff0000"/>
        <text x="${x + 15}" y="${y + 30}" font-size="24" fill="#ffffff" font-family="sans-serif">${n}</text>
      `;
    })
    .join("\n");

  const svg = Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${boxesSvg}
    </svg>
  `);

  const outPath = path.join(ASSETS_DIR, `${nanoid(16)}.jpg`);

  // ★画像を少し縮小して軽量化（LINE取得・メモリ負荷改善）
  await img
    .resize({ width: 960, withoutEnlargement: true })
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: 78 })
    .toFile(outPath);

  return { outPath, picked };
}

function buildTipsText(marks) {
  if (!marks || marks.length === 0) return "改善ポイントを抽出できませんでした。";
  return marks
    .slice(0, 3)
    .map((m, i) => `${i + 1}. ${m.label}：${m.advice}`)
    .join("\n");
}

// ========= 直近動画解析結果（メモリ） =========
const lastAnalysisByKey = {}; // memoryKey -> { at, shot_type, notes, tipsText }

// ========= 重い解析をバックグラウンドで実行してpush送信 =========
async function processVideoAndPush(event) {
  const targetId = getTargetId(event);
  const memoryKey = getMemoryKey(event);
  if (!targetId) return;

  try {
    const videoPath = await downloadLineVideo(event.message.id);
    const framesDir = path.join("/tmp", `frames_${event.message.id}`);
    const frames = await extractFrames(videoPath, framesDir);

    if (!frames.length) {
      await client.pushMessage(targetId, {
        type: "text",
        text: "動画からフレームを抽出できませんでした。別の動画で再度お試しください。",
      });
      return;
    }

    // 1枚目だけでテニス判定＆指摘（軽量優先）
    const analysis = await analyzeFrameWithOpenAI(frames[0]);

    if (!analysis?.is_tennis) {
      await client.pushMessage(targetId, {
        type: "text",
        text: "テニスに関係ない動画のため、返答できません。",
      });
      return;
    }

    const { outPath, picked } = await drawMarks(frames[0], analysis.marks || []);

    // ★ファイル名でURL生成（Map不要）
    const imgUrl = `${PUBLIC_BASE_URL}/assets/${path.basename(outPath)}`;
    const tipsText = buildTipsText(picked);

    lastAnalysisByKey[memoryKey] = {
      at: Date.now(),
      shot_type: analysis.shot_type || "unknown",
      notes: analysis.notes || "",
      tipsText,
    };

    await client.pushMessage(targetId, [
      { type: "image", originalContentUrl: imgUrl, previewImageUrl: imgUrl },
      {
        type: "text",
        text:
          `改善ポイント（画像の番号に対応）\n` +
          `${tipsText}\n\n` +
          `目的（例：安定、スピード、回転、コース）を送ってください。直近の動画を前提に再アドバイスします。`,
      },
    ]);
  } catch (error) {
    console.error("Video analyze error:", error?.stack || error);
    if (error?.response) {
      console.error("HTTP status:", error.response.status);
      console.error("HTTP data:", JSON.stringify(error.response.data));
    }

    const targetId = getTargetId(event);
    if (targetId) {
      await client.pushMessage(targetId, {
        type: "text",
        text: "解析中にエラーが発生しました。動画を短くして再送するか、時間をおいて再度お試しください。",
      });
    }
  }
}

// ========= メインイベント処理 =========
async function handleEvent(event) {
  if (event.type !== "message") return null;

  // --- 動画が来たら：即返信（replyMessage）→解析はpushで返す ---
  if (event.message.type === "video") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "動画を受け取りました。解析中です（30秒ほど）🎾",
    });

    processVideoAndPush(event);
    return null;
  }

  // --- テキスト質問：直近解析を前提に回答 ---
  if (event.message.type === "text") {
    const text = event.message.text || "";
    const memoryKey = getMemoryKey(event);
    const last = lastAnalysisByKey[memoryKey];

    if (!isRelatedToTennis(text)) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "テニスに関係ない内容のため、返答できません。",
      });
    }

    if (!last) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "先にフォーム動画を送ってください。フレームにマークを付けて改善点を返します。",
      });
    }

    try {
      const prompt = `
あなたは日本語のAIテニスコーチ。
直近動画の解析結果（番号付き）：
${last.tipsText}

補足：ショット種別=${last.shot_type}, 所感=${last.notes}

ユーザー質問：
「${text}」

この解析結果を前提に、
- 改善アドバイスを3〜5個（箇条書き）
- 練習ドリルを2つ
を提案してください。
`.trim();

      const resp = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: OPENAI_TEXT_MODEL,
          messages: [
            { role: "system", content: "あなたは日本語で親切に具体的に答えるAIテニスコーチです。" },
            { role: "user", content: prompt },
          ],
          temperature: 0.4,
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 60000,
        }
      );

      const reply = resp.data?.choices?.[0]?.message?.content?.trim() || "回答生成に失敗しました。";
      return client.replyMessage(event.replyToken, { type: "text", text: reply });
    } catch (error) {
      console.error("Follow-up error:", error?.stack || error);
      if (error?.response) console.error("OpenAI data:", JSON.stringify(error.response.data));
      return client.replyMessage(event.replyToken, { type: "text", text: "再アドバイス生成中にエラーが発生しました。" });
    }
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "テニスの動画（mp4）を送ってください。フレームにマークを付けて改善点を返します。",
  });
}

// ========= 起動 =========
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server is running on port ${port}`));
