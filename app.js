const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const sharp = require("sharp");
require("dotenv").config();

const app = express();

/* ================= 基本設定 ================= */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.PUBLIC_BASE_URL;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

/* ================= 一時保存 ================= */
const TMP = "/tmp";
const ASSET_DIR = `${TMP}/assets`;
fs.mkdirSync(ASSET_DIR, { recursive: true });

const lastAnalysis = {}; // userId -> analysis

/* ================= assets配信 ================= */
app.get("/assets/:file", (req, res) => {
  const p = path.join(ASSET_DIR, req.params.file);
  if (!fs.existsSync(p)) return res.sendStatus(404);
  res.sendFile(p);
});

/* ================= Webhook ================= */
app.post("/webhook", bodyParser.raw({ type: "*/*" }), (req, res) => {
  const sig = req.headers["x-line-signature"];
  if (!line.validateSignature(req.body, config.channelSecret, sig)) {
    return res.sendStatus(401);
  }
  const body = JSON.parse(req.body.toString());
  Promise.all(body.events.map(handleEvent))
    .then(() => res.json({ ok: true }))
    .catch(() => res.sendStatus(500));
});

/* ================= Event ================= */
async function handleEvent(event) {
  if (event.type !== "message") return;

  const userId = event.source.userId;

  /* ---- 動画 ---- */
  if (event.message.type === "video") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "動画を受け取りました。解析中です（30秒ほど）🎾",
    });
    analyzeVideo(event, userId);
    return;
  }

  /* ---- テキスト（テニス用語不要） ---- */
  if (event.message.type === "text") {
    if (!lastAnalysis[userId]) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "先にフォーム動画を送ってください。",
      });
    }

    const prompt = `
あなたは日本語のテニスコーチです。
以下の解析結果を前提に、質問に答えてください。

解析結果：
${lastAnalysis[userId].text}

ユーザーの質問：
「${event.message.text}」

・具体的に
・初心者にも分かるように
`;

    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
      },
      {
        headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      }
    );

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: r.data.choices[0].message.content,
    });
  }
}

/* ================= 動画解析 ================= */
async function analyzeVideo(event, userId) {
  try {
    const videoPath = `${TMP}/${event.message.id}.mp4`;
    const stream = await client.getMessageContent(event.message.id);
    await stream.pipe(fs.createWriteStream(videoPath));

    /* --- 5秒ごとにフレーム --- */
    const frameDir = `${TMP}/frames_${Date.now()}`;
    fs.mkdirSync(frameDir);
    await exec("ffmpeg", [
      "-i",
      videoPath,
      "-vf",
      "fps=1/5,scale=640:-2",
      "-frames:v",
      "3",
      `${frameDir}/f_%02d.jpg`,
    ]);

    const frames = fs.readdirSync(frameDir).map(f => `${frameDir}/${f}`);

    /* --- 1枚目だけVision解析 --- */
    const vision = await analyzeFrame(frames[0]);

    if (!vision.marks?.length) {
      return client.pushMessage(userId, {
        type: "text",
        text: "改善ポイントを検出できませんでした。",
      });
    }

    /* --- 各マークごとに画像生成 --- */
    const messages = [];
    let text = "改善ポイント（番号と画像が対応）\n";

    for (let i = 0; i < vision.marks.length; i++) {
      const m = vision.marks[i];
      const img = await cropMark(frames[0], m, i + 1);
      messages.push({
        type: "image",
        originalContentUrl: img,
        previewImageUrl: img,
      });
      text += `\n【${i + 1}】${m.label}\n${m.advice}\n`;
    }

    lastAnalysis[userId] = { text };

    messages.push({
      type: "text",
      text: text + "\n気になる点を自由に聞いてください。",
    });

    await client.pushMessage(userId, messages);
  } catch (e) {
    await client.pushMessage(userId, {
      type: "text",
      text: "解析中にエラーが発生しました。動画を短くして再送してください。",
    });
  }
}

/* ================= Vision ================= */
async function analyzeFrame(imgPath) {
  const b64 = fs.readFileSync(imgPath).toString("base64");
  const r = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "テニスのフォーム改善点を最大3つJSONで返してください。" },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
          ],
        },
      ],
    },
    { headers: { Authorization: `Bearer ${OPENAI_KEY}` } }
  );
  return JSON.parse(r.data.choices[0].message.content);
}

/* ================= 画像切り出し ================= */
async function cropMark(imgPath, m, idx) {
  const img = sharp(imgPath);
  const meta = await img.metadata();

  const out = `${ASSET_DIR}/p${Date.now()}_${idx}.jpg`;

  await img
    .extract({
      left: Math.round(m.x * meta.width),
      top: Math.round(m.y * meta.height),
      width: Math.round(m.w * meta.width),
      height: Math.round(m.h * meta.height),
    })
    .jpeg()
    .toFile(out);

  return `${BASE_URL}/assets/${path.basename(out)}`;
}

/* ================= exec helper ================= */
function exec(cmd, args) {
  return new Promise((res, rej) => {
    execFile(cmd, args, e => (e ? rej(e) : res()));
  });
}

/* ================= 起動 ================= */
app.listen(PORT, () => console.log("Server running", PORT));
