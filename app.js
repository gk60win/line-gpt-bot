/**
 * Render Free向け：落ちにくい最小構成 + 動画→フレーム抽出→(テニス判定/指摘JSON)→
 * 指摘数と同じ枚数の「切り出し画像(①②③)」を返す
 *
 * 必要Env:
 *  LINE_CHANNEL_ACCESS_TOKEN
 *  LINE_CHANNEL_SECRET
 *  OPENAI_API_KEY
 *  PUBLIC_BASE_URL   例) https://xxxx.onrender.com
 *
 * 推奨Env(任意):
 *  OPENAI_VISION_MODEL 例) gpt-4o-mini
 *  OPENAI_TEXT_MODEL   例) gpt-4o-mini
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

// ===================== 安定化（落ちにくくする） =====================
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";

// Renderは /tmp が使える
const ASSETS_DIR = "/tmp/assets";
fs.mkdirSync(ASSETS_DIR, { recursive: true });

// token -> filepath (再起動で消える簡易配信)
const assetMap = new Map();
app.get("/assets/:token", (req, res) => {
  const p = assetMap.get(req.params.token);
  if (!p || !fs.existsSync(p)) return res.sendStatus(404);
  res.sendFile(p);
});
function publishAsset(filePath, ttlMs = 10 * 60 * 1000) {
  const token = nanoid(18);
  assetMap.set(token, filePath);
  setTimeout(() => assetMap.delete(token), ttlMs);
  return `${PUBLIC_BASE_URL}/assets/${token}`;
}

// ===================== メモリ（直近解析） =====================
const lastAnalysisByKey = {}; // memoryKey -> { at, shot_type, points:[{title, advice, imgUrl}] }
const MEMORY_TTL_MS = 30 * 60 * 1000; // 30分

function getTargetId(event) {
  return event.source.userId || event.source.groupId || event.source.roomId || null;
}
function getMemoryKey(event) {
  if (event.source.userId) return `user_${event.source.userId}`;
  if (event.source.groupId) return `group_${event.source.groupId}`;
  if (event.source.roomId) return `room_${event.source.roomId}`;
  return "unknown";
}
function getLast(memoryKey) {
  const v = lastAnalysisByKey[memoryKey];
  if (!v) return null;
  if (Date.now() - v.at > MEMORY_TTL_MS) return null;
  return v;
}

// 1ユーザー(キー)につき解析を直列化（Freeで重い処理が被ると落ちやすい）
const queueByKey = new Map();
function enqueue(memoryKey, taskFn) {
  const prev = queueByKey.get(memoryKey) || Promise.resolve();
  const next = prev
    .catch(() => {}) // 前の失敗で鎖が切れないように
    .then(taskFn)
    .finally(() => {
      // 最後が自分なら消す
      if (queueByKey.get(memoryKey) === next) queueByKey.delete(memoryKey);
    });
  queueByKey.set(memoryKey, next);
  return next;
}

// ===================== LINE webhook（署名検証のため raw） =====================
app.post("/webhook", bodyParser.raw({ type: "*/*" }), async (req, res) => {
  const signature = req.headers["x-line-signature"];
  const body = req.body;

  if (!line.validateSignature(body, config.channelSecret, signature)) {
    return res.status(401).send("Unauthorized");
  }

  let parsed;
  try {
    parsed = JSON.parse(body.toString());
  } catch (e) {
    console.error("JSON parse error:", e);
    return res.status(400).end();
  }

  Promise.all((parsed.events || []).map(handleEvent))
    .then((r) => res.json(r))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// ===================== 動画DL（LINE） =====================
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

// ===================== ffmpeg で “代表フレーム” 抽出（2枚） =====================
// 1.2秒 と 2.8秒 をサムネに（短い動画でも当たりやすい）
async function extractKeyFrames(videoPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const stamps = ["5", "8"];
  const outputs = [];

  for (let i = 0; i < stamps.length; i++) {
    const outJpg = path.join(outDir, `key_${i + 1}.jpg`);
    const args = [
      "-ss",
      stamps[i],
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=960:-2",
      "-q:v",
      "3",
      outJpg,
      "-y",
    ];

    await new Promise((resolve, reject) => {
      execFile("ffmpeg", args, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve();
      });
    });

    if (fs.existsSync(outJpg)) outputs.push(outJpg);
  }

  return outputs;
}

function toDataUrl(jpgPath) {
  const b64 = fs.readFileSync(jpgPath).toString("base64");
  return `data:image/jpeg;base64,${b64}`;
}

// ===================== OpenAI（画像→テニス判定&指摘JSON） =====================
// ★重要：points(=改善点)は 1〜3 個を強制。各pointは “そのpointに対応する矩形” を持つ。
// これで「画像枚数＝改善点数」を実現し、噛み合わない問題を減らす。
async function analyzeFrame(jpgPath) {
  const prompt = `
あなたは日本語のテニス専門コーチです。
入力画像が「テニスのプレー場面（人物+ラケット/ボール/コートなど）」でない場合は is_tennis=false にしてください。

テニスの場合は、改善点を 1〜3個に絞ってください（0個は禁止）。
各改善点は、画像上の該当箇所を 0〜1 の相対座標で矩形(x,y,w,h)として返してください。
矩形は「改善点の根拠が写っている場所」にしてください（関係ない背景を指さない）。

必ず JSON のみを返してください（コードブロック禁止）。

出力例：
{
  "is_tennis": true,
  "shot_type": "serve"|"forehand"|"backhand"|"volley"|"unknown",
  "points": [
    {"title":"短い見出し","advice":"具体的改善アドバイス","x":0.1,"y":0.2,"w":0.2,"h":0.25}
  ]
}
`.trim();

  const resp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: OPENAI_VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: toDataUrl(jpgPath) } },
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

// ===================== ①②③の“番号付き切り出し画像”を作る =====================
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// 画像全体に対する相対矩形 -> ピクセル矩形
function relRectToPx(meta, r) {
  const W = meta.width;
  const H = meta.height;
  const x = clamp(Math.round(r.x * W), 0, W - 1);
  const y = clamp(Math.round(r.y * H), 0, H - 1);
  const w = clamp(Math.round(r.w * W), 1, W - x);
  const h = clamp(Math.round(r.h * H), 1, H - y);
  return { x, y, w, h, W, H };
}

// 切り出しは少し広げる（見切れ対策）
function expandRect(px, pad = 0.25) {
  const padX = Math.round(px.w * pad);
  const padY = Math.round(px.h * pad);
  const x = clamp(px.x - padX, 0, px.W - 1);
  const y = clamp(px.y - padY, 0, px.H - 1);
  const w = clamp(px.w + padX * 2, 1, px.W - x);
  const h = clamp(px.h + padY * 2, 1, px.H - y);
  return { x, y, w, h };
}

async function makeNumberedCrop(jpgPath, rectRel, number) {
  const img = sharp(jpgPath);
  const meta = await img.metadata();
  const px = relRectToPx(meta, rectRel);
  const crop = expandRect({ ...px, W: meta.width, H: meta.height }, 0.35);

  // クロップしてから番号と枠を重ねる（＝“この画像はこの指摘のための画像”が明確）
  const cropImg = img.extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h });
  const W = crop.w;
  const H = crop.h;

  // 枠は「元の指摘矩形」をクロップ座標系へ変換
  const innerX = clamp(px.x - crop.x, 0, W - 1);
  const innerY = clamp(px.y - crop.y, 0, H - 1);
  const innerW = clamp(px.w, 1, W - innerX);
  const innerH = clamp(px.h, 1, H - innerY);

  const svg = Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${innerX}" y="${innerY}" width="${innerW}" height="${innerH}"
            fill="none" stroke="#ff0000" stroke-width="10"/>
      <circle cx="40" cy="40" r="32" fill="#ff0000"/>
      <text x="28" y="52" font-size="34" fill="#ffffff" font-family="sans-serif">${number}</text>
    </svg>
  `);

  const outPath = path.join(ASSETS_DIR, `${nanoid(16)}.jpg`);
  await cropImg
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toFile(outPath);

  return outPath;
}

// ===================== 重い処理：動画→解析→push =====================
async function processVideoAndPush(event) {
  const targetId = getTargetId(event);
  const memoryKey = getMemoryKey(event);
  if (!targetId) return;

  // PUBLIC_BASE_URLが未設定だと画像URLが壊れるので、最初に弾く
  if (!PUBLIC_BASE_URL) {
    await client.pushMessage(targetId, {
      type: "text",
      text: "サーバー設定エラー：PUBLIC_BASE_URL が未設定です（RenderのEnvironmentで設定してください）。",
    });
    return;
  }

  try {
    const videoPath = await downloadLineVideo(event.message.id);
    const outDir = path.join("/tmp", `frames_${event.message.id}`);
    const frames = await extractKeyFrames(videoPath, outDir);

    if (!frames.length) {
      await client.pushMessage(targetId, {
        type: "text",
        text: "動画からフレームを抽出できませんでした。別の動画でお試しください。",
      });
      return;
    }

    // 2枚のうち、テニス判定trueになった方を採用（より当たりやすい）
    let best = null;
    for (const f of frames) {
      try {
        const a = await analyzeFrame(f);
        if (a?.is_tennis && Array.isArray(a.points) && a.points.length > 0) {
          best = { frame: f, analysis: a };
          break;
        }
      } catch (e) {
        console.error("analyzeFrame failed on", f, e?.message || e);
      }
    }

    if (!best) {
      await client.pushMessage(targetId, {
        type: "text",
        text: "テニスに関係ない動画、またはプレー場面が判別できませんでした。フォームが写る角度で再送してください。",
      });
      return;
    }

    const points = best.analysis.points.slice(0, 3);
    const shotType = best.analysis.shot_type || "unknown";

    // 指摘数と同じ枚数の「切り出し画像(①②③)」を作成
    const outImages = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      // 座標が壊れている場合に備え、最低限の検証
      const rectRel = {
        x: Number.isFinite(p.x) ? p.x : 0.3,
        y: Number.isFinite(p.y) ? p.y : 0.3,
        w: Number.isFinite(p.w) ? p.w : 0.3,
        h: Number.isFinite(p.h) ? p.h : 0.3,
      };
      const outPath = await makeNumberedCrop(best.frame, rectRel, i + 1);
      const url = publishAsset(outPath);
      outImages.push(url);
    }

    // メモリ保存（テニス用語がなくても follow-up できるようにする）
    lastAnalysisByKey[memoryKey] = {
      at: Date.now(),
      shot_type: shotType,
      points: points.map((p, i) => ({
        title: String(p.title || `改善点${i + 1}`),
        advice: String(p.advice || ""),
        imgUrl: outImages[i],
      })),
    };

    // push：まず概要
    await client.pushMessage(targetId, {
      type: "text",
      text:
        `解析完了🎾（${points.length}点 / shot=${shotType}）\n` +
        `以下、①〜の画像とセットで改善点を送ります。\n` +
        `このあと「目的（例：安定/スピード/回転/コース）」や「何を直したいか」だけ送ってくれてもOKです。`,
    });

    // push：指摘ごとに「画像→説明」を並べる（＝噛み合う）
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const title = String(p.title || `改善点${i + 1}`);
      const advice = String(p.advice || "（アドバイスが生成できませんでした）");

      await client.pushMessage(targetId, [
        { type: "image", originalContentUrl: outImages[i], previewImageUrl: outImages[i] },
        { type: "text", text: `【${i + 1}】${title}\n${advice}` },
      ]);
    }

    // 最後に促し
    await client.pushMessage(targetId, {
      type: "text",
      text: "目的や悩みを一言で送ってください（例：『安定したい』『回転を増やしたい』『ネット多い』など）。直近動画を前提に追加で具体化します。",
    });
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

// ===================== follow-up（テニス用語なくても回答） =====================
async function answerFollowUp(event, userText) {
  const memoryKey = getMemoryKey(event);
  const last = getLast(memoryKey);

  if (!last) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "先にフォーム動画を送ってください。改善点の切り出し画像(①②③)付きで返します。",
    });
  }

  // 直近解析があるなら、テニス用語チェックは緩める（＝改善）
  // ただし明らかに無関係な雑談は軽く戻す
  const tooRandom =
    userText.length <= 2 ||
    /^(こんにちは|こんばんは|おはよう|ありがと|ありがとう|ok|OK|了解|りょ|うん)$/i.test(userText.trim());

  if (tooRandom) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "OK！目的（安定/スピード/回転/コース）や、どの番号(①②③)を直したいかを一言で送ってください。",
    });
  }

  const pointsText = last.points
    .map((p, i) => `【${i + 1}】${p.title}\n${p.advice}`)
    .join("\n\n");

  const prompt = `
あなたは日本語のAIテニスコーチ。
直近動画の解析（画像番号に対応）：
${pointsText}

ユーザーの追加質問/要望：
「${userText}」

この動画の内容を前提に、次を出してください：
- 追加アドバイス：3〜5個（箇条書き）
- 具体的ドリル：2つ（各ドリルは「やり方」「回数/目安」「チェックポイント」）
- 可能なら「①②③のどれが優先か」も一言
`.trim();

  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: OPENAI_TEXT_MODEL,
        messages: [
          { role: "system", content: "あなたは日本語で具体的に答えるAIテニスコーチです。" },
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

// ===================== メインイベント処理 =====================
async function handleEvent(event) {
  if (event.type !== "message") return null;

  // 動画：即reply → 重処理はpush（Render Free向け）
  if (event.message.type === "video") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "動画を受け取りました。解析中です（30〜60秒ほど）🎾",
    });

    const memoryKey = getMemoryKey(event);
    // 直列キューで安全に回す
    enqueue(memoryKey, async () => {
      await processVideoAndPush(event);
    });

    return null;
  }

  // テキスト：直近解析があればテニス用語なしでも回答
  if (event.message.type === "text") {
    const userText = event.message.text || "";
    return answerFollowUp(event, userText);
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "テニスの動画（mp4）を送ってください。改善点の切り出し画像(①②③)付きで返します。",
  });
}

// ===================== 起動 =====================
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server is running on port ${port}`));
