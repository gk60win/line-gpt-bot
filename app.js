/**
 * Free専用・安定重視 LINE テニス動画コーチ Bot (Render)
 * - 動画が来たら即reply → 重い解析はpushで返す
 * - 改善ポイント数 = 切り出し画像数（最大3）
 * - 画像(番号)と文章(番号)が必ず一致（marksを強制ソート）
 * - 直近解析がある場合：テニス用語が無い追加質問でも回答する
 * - /tmp に保存、/assets/:token で一時配信（10分で消える）
 */

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

// ========= 環境変数 =========
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // 例: https://line-gpt-bot-xxx.onrender.com

if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET || !OPENAI_API_KEY || !PUBLIC_BASE_URL) {
  console.error("Missing env. Required: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, OPENAI_API_KEY, PUBLIC_BASE_URL");
}

const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";

// ========= LINE =========
const config = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// ========= Express =========
const app = express();

// 署名検証のため raw body
app.post("/webhook", bodyParser.raw({ type: "*/*" }), async (req, res) => {
  try {
    const signature = req.headers["x-line-signature"];
    const body = req.body;

    if (!line.validateSignature(body, config.channelSecret, signature)) {
      return res.status(401).send("Unauthorized");
    }

    const parsedBody = JSON.parse(body.toString());
    await Promise.all(parsedBody.events.map(handleEvent));
    res.json({ ok: true });
  } catch (e) {
    console.error("webhook error:", e?.stack || e);
    res.status(500).end();
  }
});

// ========= Free向け軽量設定 =========
const ASSETS_DIR = "/tmp/assets";
fs.mkdirSync(ASSETS_DIR, { recursive: true });

// token -> filePath の簡易マップ（再起動で消える）
const assetMap = new Map();

// 一時アセット配信
app.get("/assets/:token", (req, res) => {
  const token = req.params.token;
  const filePath = assetMap.get(token);
  if (!filePath || !fs.existsSync(filePath)) return res.sendStatus(404);
  res.sendFile(filePath);
});

function publishAsset(filePath) {
  const token = nanoid(18);
  assetMap.set(token, filePath);
  setTimeout(() => assetMap.delete(token), 10 * 60 * 1000); // 10分後にmapから削除
  return `${PUBLIC_BASE_URL}/assets/${token}`;
}

// ========= 直近解析結果（メモリ：再起動で消える） =========
const lastAnalysisByKey = {}; // key -> {at, shot_type, notes, tipsText}

// ========= ユーザー/グループ宛先 =========
function getTargetId(event) {
  if (event?.source?.userId) return event.source.userId;
  if (event?.source?.groupId) return event.source.groupId;
  if (event?.source?.roomId) return event.source.roomId;
  return null;
}
function getMemoryKey(event) {
  if (event?.source?.userId) return `user_${event.source.userId}`;
  if (event?.source?.groupId) return `group_${event.source.groupId}`;
  if (event?.source?.roomId) return `room_${event.source.roomId}`;
  return `unknown`;
}

// ========= テニス判定（初回テキスト用） =========
function isRelatedToTennis(text) {
  if (!text) return false;
  const keywords = [
    "テニス", "サーブ", "フォア", "フォアハンド", "バック", "バックハンド",
    "ボレー", "スマッシュ", "ストローク", "スライス", "トップスピン",
    "回転", "打点", "トス", "戦術", "配球", "リターン", "ラケット", "ガット",
  ];
  return keywords.some((k) => text.includes(k));
}

// ========= LINE動画を保存 =========
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

// ========= ffmpegでフレーム切り出し（Free向け軽量） =========
const SEEK_SECONDS = 1.5;                 // 少し後ろから
const VIDEO_ANALYZE_SECONDS = 6;          // 解析範囲
const FPS_FILTER = "fps=1/3,scale=640:-2"; // 3秒に1枚、横640
const MAX_FRAMES = 2;                     // 最大2枚（今回は1枚目中心）

async function extractFrames(videoPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "frame_%02d.jpg");

  const args = [
    "-ss", String(SEEK_SECONDS),
    "-t", String(VIDEO_ANALYZE_SECONDS),
    "-i", videoPath,
    "-vf", FPS_FILTER,
    "-frames:v", String(MAX_FRAMES),
    "-q:v", "5",
    outPath,
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

// ========= OpenAIに送る画像（識別しやすく） =========
const AI_SEND_WIDTH = 512;
const AI_SEND_QUALITY = 70;

async function toDataUrlResized(jpgPath) {
  const buf = await sharp(jpgPath)
    .resize({ width: AI_SEND_WIDTH })
    .jpeg({ quality: AI_SEND_QUALITY })
    .toBuffer();
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

// ========= marks順を固定（ズレ防止） =========
function sortMarks(marks = []) {
  const sevRank = { high: 0, mid: 1, low: 2 };
  return [...marks].sort((a, b) => {
    const sa = sevRank[a.severity] ?? 9;
    const sb = sevRank[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    const ya = a.y ?? 0, yb = b.y ?? 0;
    if (ya !== yb) return ya - yb;
    const xa = a.x ?? 0, xb = b.x ?? 0;
    return xa - xb;
  });
}

// ========= OpenAI Vision 解析 =========
async function analyzeFrameWithOpenAI(jpgPath) {
  const prompt = `
あなたはテニス専門コーチです。
画像がテニスでない場合のみ is_tennis=false を返してください。

テニスの場合は必ず marks を 1〜3 件返してください。
各 marks は「枠で囲った箇所」だけに対応する指摘にしてください。
- label は必ず「部位/道具/動き」が分かる具体名（例：利き手の手首、前足、肩の向き、ラケット面、トス位置）
- advice はその枠の中で改善できることだけを書く（抽象論や全体論は書かない）
- x,y,w,h は 0〜1 の相対座標で、枠は対象を十分に含むように（多少大きめOK）

JSONのみで返してください（コードブロック禁止）。

出力形式:
{
  "is_tennis": true/false,
  "shot_type": "serve"|"forehand"|"backhand"|"volley"|"unknown",
  "notes": "短い所感（1行）",
  "marks": [
    {"label":"具体名","severity":"low"|"mid"|"high","x":0.2,"y":0.3,"w":0.25,"h":0.25,"advice":"枠に対応した具体改善"}
  ]
}
`.trim();

  const imgDataUrl = await toDataUrlResized(jpgPath);

  const resp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: OPENAI_VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imgDataUrl } },
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

  const content = resp.data?.choices?.[0]?.message?.content || "";
  const jsonText = content.match(/\{[\s\S]*\}/)?.[0] || "";
  return JSON.parse(jsonText);
}

// ========= 1ポイント=1画像：切り出し＋番号＋枠 =========
async function makePointCrops(jpgPath, marks) {
  const img = sharp(jpgPath);
  const meta = await img.metadata();
  const W = meta.width;
  const H = meta.height;

  const picked = (marks || []).slice(0, 3);
  const results = [];

  for (let i = 0; i < picked.length; i++) {
    const m = picked[i];
    const n = i + 1;

    let x = Math.max(0, Math.min(W - 2, Math.round((m.x ?? 0) * W)));
    let y = Math.max(0, Math.min(H - 2, Math.round((m.y ?? 0) * H)));
    let w = Math.max(10, Math.min(W - x, Math.round((m.w ?? 0.2) * W)));
    let h = Math.max(10, Math.min(H - y, Math.round((m.h ?? 0.2) * H)));

    const pad = Math.max(40, Math.round(Math.max(w, h) * 0.4));

    const cx1 = Math.max(0, x - pad);
    const cy1 = Math.max(0, y - pad);
    const cx2 = Math.min(W, x + w + pad);
    const cy2 = Math.min(H, y + h + pad);

    const cropW = cx2 - cx1;
    const cropH = cy2 - cy1;

    const rx = x - cx1;
    const ry = y - cy1;

    const svg = Buffer.from(`
      <svg width="${cropW}" height="${cropH}" xmlns="http://www.w3.org/2000/svg">
        <rect x="${rx}" y="${ry}" width="${w}" height="${h}"
              fill="none" stroke="#ff0000" stroke-width="8"/>
        <circle cx="${Math.min(rx + 36, cropW - 36)}" cy="${Math.min(ry + 36, cropH - 36)}" r="30" fill="#ff0000"/>
        <text x="${Math.min(rx + 24, cropW - 48)}" y="${Math.min(ry + 48, cropH - 24)}"
              font-size="36" fill="#ffffff" font-family="sans-serif">${n}</text>
      </svg>
    `);

    const outPath = path.join(ASSETS_DIR, `${nanoid(16)}_p${n}.jpg`);

    await sharp(jpgPath)
      .extract({ left: cx1, top: cy1, width: cropW, height: cropH })
      .composite([{ input: svg, top: 0, left: 0 }])
      .jpeg({ quality: 85 })
      .toFile(outPath);

    results.push({ outPath, mark: m, number: n });
  }

  return results;
}

// ========= 文章は marks の順で作る（必ず番号一致） =========
function buildTipsTextFromMarks(marks) {
  if (!marks || marks.length === 0) return "改善ポイントを抽出できませんでした。";
  return marks
    .slice(0, 3)
    .map((m, i) => `${i + 1}. ${m.label}：${m.advice}`)
    .join("\n");
}

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

    const analysis = await analyzeFrameWithOpenAI(frames[0]);

    if (!analysis?.is_tennis) {
      await client.pushMessage(targetId, { type: "text", text: "テニスに関係ない動画のため、返答できません。" });
      return;
    }

    // ★順序固定（重要）
    analysis.marks = sortMarks(analysis.marks || []).slice(0, 3);

    if (!analysis.marks.length) {
      await client.pushMessage(targetId, {
        type: "text",
        text: "フォームは確認できましたが、改善箇所を画像上で特定できませんでした。もう少し近い動画（全身＋ラケットが大きく映る）で再送してください。",
      });
      return;
    }

    // 改善ポイント数 = 切り出し画像数
    const crops = await makePointCrops(frames[0], analysis.marks);

    // 画像メッセージ（最大3）
    const imageMsgs = crops.map((c) => {
      const url = publishAsset(c.outPath);
      return { type: "image", originalContentUrl: url, previewImageUrl: url };
    });

    // テキスト（番号は marks の順に一致）
    const tipsText = buildTipsTextFromMarks(analysis.marks);

    // メモリ保存（後続の質問で使う）
    lastAnalysisByKey[memoryKey] = {
      at: Date.now(),
      shot_type: analysis.shot_type || "unknown",
      notes: analysis.notes || "",
      tipsText,
    };

    await client.pushMessage(targetId, [
      ...imageMsgs,
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

// ========= 直近解析を前提に追加質問へ回答 =========
async function replyFollowUp(event, userText) {
  const memoryKey = getMemoryKey(event);
  const last = lastAnalysisByKey[memoryKey];

  if (!last) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "先にフォーム動画を送ってください。改善ポイント（番号付き画像）とアドバイスを返します。",
    });
  }

  const prompt = `
あなたは日本語のAIテニスコーチです。
直近動画の改善ポイント（番号付き）：
${last.tipsText}

補足：ショット種別=${last.shot_type}, 所感=${last.notes}

ユーザー質問：
「${userText}」

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
}

// ========= メインイベント処理 =========
async function handleEvent(event) {
  if (event.type !== "message") return null;

  // 動画
  if (event.message.type === "video") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "動画を受け取りました。解析中です（30秒ほど）🎾",
    });
    processVideoAndPush(event);
    return null;
  }

  // テキスト
  if (event.message.type === "text") {
    const text = (event.message.text || "").trim();

    const memoryKey = getMemoryKey(event);
    const last = lastAnalysisByKey[memoryKey];

    // ✅ 直近解析があるなら、テニス用語なしでも追加質問として回答
    if (last) {
      try {
        return await replyFollowUp(event, text);
      } catch (e) {
        console.error("Follow-up error:", e?.stack || e);
        if (e?.response) console.error("OpenAI data:", JSON.stringify(e.response.data));
        return client.replyMessage(event.replyToken, { type: "text", text: "再アドバイス生成中にエラーが発生しました。" });
      }
    }

    // ✅ 直近解析がない場合だけ、テニス用語で判定
    if (!isRelatedToTennis(text)) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "テニスのフォーム動画（mp4）を送ってください。解析して改善ポイント（番号付き画像）を返します。",
      });
    }

    // テニス用語があっても、動画が無いときは動画誘導（必要ならここを一般回答に拡張可）
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "まずフォーム動画を送ってください。改善ポイント（番号付き画像）とアドバイスを返します。",
    });
  }

  // その他
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "テニスの動画（mp4）を送ってください。改善ポイント（番号付き画像）とアドバイスを返します。",
  });
}

// ========= 予期せぬ例外で落ちないように =========
process.on("unhandledRejection", (reason) => console.error("unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

// ========= 起動 =========
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server is running on port ${port}`));
