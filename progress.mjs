import { MongoClient } from "mongodb";
import http from "node:http";
import fs from "node:fs";

try {
  const env = fs.readFileSync(".env", "utf-8");
  for (const line of env.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* no .env file */ }

const PORT = parseInt(process.env.PORT || "3456", 10);
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME;
const COMPANY_COL = process.env.COLLECTION_NAME || "companies";
const MESSAGES_COL = process.env.MESSAGES_COLLECTION || "messages";

async function getProgress() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  // Classification progress
  const total = await db.collection(COMPANY_COL).countDocuments({});
  const byStatus = await db.collection(COMPANY_COL).aggregate([
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]).toArray();
  const byModel = await db.collection(COMPANY_COL).aggregate([
    { $group: { _id: "$ai_model", count: { $sum: 1 } } },
  ]).toArray();
  const lastClassified = await db.collection(COMPANY_COL)
    .find({}, { projection: { title: 1, status: 1, ai_model: 1, ai_confidence: 1, _id: 0 } })
    .sort({ _id: -1 })
    .limit(10)
    .toArray();

  // Messages progress
  const messagesTotal = await db.collection(MESSAGES_COL).countDocuments({});
  const byCharCount = await db.collection(MESSAGES_COL).aggregate([
    { $bucket: { groupBy: "$char_count", boundaries: [0, 200, 250, 1000], default: "over_250", output: { count: { $sum: 1 } } } },
  ]).toArray();
  const lastMessages = await db.collection(MESSAGES_COL)
    .find({}, { projection: { title: 1, char_count: 1, message: 1, ai_model: 1, _id: 0 } })
    .sort({ _id: -1 })
    .limit(5)
    .toArray();

  await client.close();

  const statusMap = {};
  for (const s of byStatus) statusMap[s._id || "null"] = s.count;
  const modelMap = {};
  for (const m of byModel) modelMap[m._id || "null"] = m.count;
  const msgBucketMap = {};
  for (const b of byCharCount) msgBucketMap[b._id] = b.count;

  return {
    classification: {
      total,
      processed: total,
      by_status: statusMap,
      by_model: modelMap,
      last_10: lastClassified,
    },
    messages: {
      total: messagesTotal,
      remaining: total - messagesTotal,
      percent: total ? Math.round((messagesTotal / total) * 100) : 0,
      by_char_count: msgBucketMap,
      last_5: lastMessages,
    },
  };
}

const server = http.createServer(async (req, res) => {
  if (req.url !== "/" && req.url !== "/progress") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });

  try {
    const data = await getProgress();
    res.end(JSON.stringify(data, null, 2));
  } catch (err) {
    res.end(JSON.stringify({ error: err.message }, null, 2));
  }
});

server.listen(PORT, () => {
  console.log(`Progress API: http://localhost:${PORT}`);
});
