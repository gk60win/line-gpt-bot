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

/* =============== 基本設定 =============== */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.PUBLIC_BASE_URL; // https://xxxx.onrender.com
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const TMP = "/tmp";
const ASSET_DIR = `${TMP}/assets`;
fs.mkdirSync(ASSET_DIR, { recursive: true });

// userId -> { text, at }
const lastAnalysis = {};

/* =============== assets配信 =============== */
app.get("/assets/:file", (req, res) => {
  const p = path.join(ASSET_DIR, req.params.file);
  if (!fs.existsSync(p)) return res.sendStatus(404);
  res.sendFile(p);
});

/* =============== Webhook =============== */
app.post("/webhook", bodyParser.raw({ type: "*/*" }), (req, res) => {
  const sig = req.headers["x-line-signature"];
  if (!line.validateSignature(req.body, config.channelSecret, sig)) {
    return res.sendStatus(401);
  }
  const body = JSON.parse(req.body.toString());
  Promise.all(body.events.map(handleEvent))
    .then(() => res.json({ ok: true }))
    .catch((e) => {
      console.error("webhook error:", e);
      res.sendStatus(500);
    });
});

/* =============== Event =============== */
async function handleEvent(event) {
  if (event.type !== "message") return;

  const userId = event.source.userId;

  // 動画
  if (event.message.type === "video") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "動画を受け取りました。解析中です（30〜60秒）🎾",
    });
    analyzeVideo(event, userId); // pushで結果送る
    return;
  }

  // テキスト（テニス用語なくてもOK：直近解析があれば回答）
  if (event.message.type === "text") {
    if (!lastAnalysis[userId]) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "先にフォーム動画を送ってください（動画→解析→画像付きで返します）。",
      });
    }

    const prompt = `
あなたは日本語のテニスコーチです。
以下の解析結果を前提に、ユーザーの質問に答えてください。
（ユーザーがテニス用語を使わなくても、文脈から意図を推測してOK）

解析結果：
${lastAnalysis[userId].text}

ユーザーの質問：
「${event.message.text}」

出力：
- 改善アドバイス 3〜5個（箇条書き）
- 練習ドリル 2つ
`;

    try {
      const r = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.4,
        },
        { headers: { Authorization: `Bearer ${OPENAI_KEY}` }, timeout: 60000 }
      );

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: r.data.choices[0].message.content,
      });
    } catch (e) {
      console.error("follow-up error:", e?.response?.data || e);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "回答生成でエラーが発生しました。もう一度お試しください。",
      });
    }
  }
}

/* =============== 動画解析（堅牢版） =============== */
async function analyzeVideo(event, userId) {
  const step = (name) => console.log(`[analyze] ${name}`);

  try {
    step("download start");
    const videoPath = `${TMP}/${event.message.id}.mp4`;

    // ★ここが重要：ストリーム書き込み完了まで待つ
    const stream = await client.getMessageContent(event.message.id);
    await writeStreamToFile(stream, videoPath);

    const st = fs.statSync(videoPath);
    console.log("[analyze] video bytes:", st.size);
    if (st.size < 20000) {
      throw new Error("video file too small (download incomplete?)");
    }

    step("ffmpeg frames start");
    const frameDir = `${TMP}/frames_${event.message.id}_${Date.now()}`;
    fs.mkdirSync(frameDir, { recursive: true });

    // ★5秒ごとに最大3枚
    await exec("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-vf",
      "fps=1/5,scale=720:-2",
      "-frames:v",
      "3",
      `${frameDir}/f_%02d.jpg`,
      "-y",
    ]);

    let frames = fs
      .readdirSync(frameDir)
      .filter((f) => f.endsWith(".jpg"))
      .sort()
      .map((f) => `${frameDir}/${f}`);

    console.log("[analyze] frames:", frames);
    if (!frames.length) throw new Error("no frames extracted");

    step("vision analyze start");
    // ★Visionは1回だけ（1枚目）
    const vision = await analyzeFrame(frames[0]);

    if (!vision.is_tennis) {
      await client.pushMessage(userId, {
        type: "text",
        text: "テニスに関係ない動画のため、返答できません。",
      });
      return;
    }

    const marks = Array.isArray(vision.marks) ? vision.marks.slice(0, 3) : [];
    if (!marks.length) {
      await client.pushMessage(userId, {
        type: "text",
        text: "改善ポイントを抽出できませんでした（フレームが暗い/遠い可能性）。もう少し近い映像で再送してください。",
      });
      return;
    }

    step("crop images start");
    const messages = [];
    let text = "改善ポイント（番号と画像が対応）\n";

    for (let i = 0; i < marks.length; i++) {
      const m = normalizeMark(marks[i]);
      const imgUrl = await cropMark(frames[0], m, i + 1);

      // 1ポイント=1画像（ズレ防止）
      messages.push({
        type: "image",
        originalContentUrl: imgUrl,
        previewImageUrl: imgUrl,
      });

      text += `\n【${i + 1}】${m.label || "改善ポイント"}\n${m.advice || ""}\n`;
    }

    lastAnalysis[userId] = { text, at: Date.now() };

    messages.push({
      type: "text",
      text: text + "\n気になる点をそのまま送ってください（例：もっと安定させたい / 何を直すべき？ など）。",
    });

    step("push send");
    await client.pushMessage(userId, messages);
    step("done");
  } catch (e) {
    console.error("analyze error:", e?.stack || e);
    if (e?.response?.data) console.error("openai:", JSON.stringify(e.response.data));

    await client.pushMessage(userId, {
      type: "text",
      text: "解析中にエラーが発生しました。動画を短くして再送してください。",
    });
  }
}

/* =============== ストリーム保存（重要） =============== */
function writeStreamToFile(stream, outPath) {
  return new Promise((resolve, reject) => {
    const w = fs.createWriteStream(outPath);
    stream.pipe(w);
    w.on("finish", resolve);
    w.on("error", reject);
    stream.on("error", reject);
  });
}

/* =============== Vision（JSON強制・失敗に強い） =============== */
async function analyzeFrame(imgPath) {
  const b64 = fs.readFileSync(imgPath).toString("base64");

  const prompt = `
あなたはテニス専門コーチです。
画像がテニスと無関係なら is_tennis=false。
テニスの場合は改善点を最大3つ、画像上の矩形を相対座標(0〜1)で返してください。
必ずJSONのみで返してください（文章禁止）。

形式:
{
  "is_tennis": true,
  "shot_type": "serve"|"forehand"|"backhand"|"volley"|"unknown",
  "marks": [
    {"label":"短い名称","x":0.1,"y":0.2,"w":0.3,"h":0.3,"advice":"具体的改善"}
  ]
}
`;

  const r = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt.trim() },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
          ],
        },
      ],
      temperature: 0.2,
    },
    { headers: { Authorization: `Bearer ${OPENAI_KEY}` }, timeout: 90000 }
  );

  const content = r.data?.choices?.[0]?.message?.content || "";
  // ★JSON以外が混ざっても落ちないよう抽出
  const jsonText = content.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) throw new Error("vision returned non-json");

  let obj;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    throw new Error("vision json parse failed");
  }

  // 最低限の保険
  if (typeof obj.is_tennis !== "boolean") obj.is_tennis = true;
  if (!Array.isArray(obj.marks)) obj.marks = [];
  return obj;
}

/* =============== 座標の正規化（sharp落ち防止） =============== */
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normalizeMark(m) {
  const x = clamp(Number(m.x ?? 0.3), 0, 0.95);
  const y = clamp(Number(m.y ?? 0.3), 0, 0.95);
  const w = clamp(Number(m.w ?? 0.2), 0.05, 0.95);
  const h = clamp(Number(m.h ?? 0.2), 0.05, 0.95);

  return {
    label: (m.label || "").toString().slice(0, 30),
    advice: (m.advice || "").toString().slice(0, 400),
    x,
    y,
    w,
    h,
  };
}

/* =============== 画像切り出し（枠外・0対策） =============== */
async function cropMark(imgPath, m, idx) {
  const img = sharp(imgPath);
  const meta = await img.metadata();
  const W = meta.width || 1;
  const H = meta.height || 1;

  // 少し余白（見切れ防止）
  const pad = 0.06;

  const x0 = clamp(m.x - pad, 0, 0.98);
  const y0 = clamp(m.y - pad, 0, 0.98);
  const x1 = clamp(m.x + m.w + pad, 0.02, 1);
  const y1 = clamp(m.y + m.h + pad, 0.02, 1);

  let left = Math.round(x0 * W);
  let top = Math.round(y0 * H);
  let width = Math.round((x1 - x0) * W);
  let height = Math.round((y1 - y0) * H);

  // sharpは0や枠外で落ちるので補正
  left = clamp(left, 0, W - 2);
  top = clamp(top, 0, H - 2);
  width = clamp(width, 20, W - left);
  height = clamp(height, 20, H - top);

  const out = `${ASSET_DIR}/p_${Date.now()}_${idx}.jpg`;
  await img.extract({ left, top, width, height }).jpeg({ quality: 85 }).toFile(out);

  return `${BASE_URL}/assets/${path.basename(out)}`;
}

/* =============== exec helper =============== */
function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve();
    });
  });
}

/* =============== 起動 =============== */
app.listen(PORT, () => console.log("Server running on", PORT));
