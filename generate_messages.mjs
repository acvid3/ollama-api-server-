import { MongoClient } from "mongodb";
import fs from "node:fs";
import path from "node:path";

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME;
const COLLECTION_NAME = process.env.COLLECTION_NAME || "companies";
const MESSAGES_COLLECTION = process.env.MESSAGES_COLLECTION || "messages";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";
const OLLAMA_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT || "60", 10) * 1000;
const MAX_RETRIES = 2;
const LIMIT = parseInt(process.env.LIMIT || "0", 10) || 0;
const LOG_FILE = process.env.LOG_FILE || "generate_messages.log";
const PROMPT_VERSION = "v1";

const logStream = fs.createWriteStream(path.resolve(LOG_FILE), { flags: "a" });
const log = {
  _write(level, args) {
    const msg = args.map(a => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      return JSON.stringify(a);
    }).join(" ");
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    if (level === "ERROR") process.stderr.write(msg + "\n");
    else process.stdout.write(msg + "\n");
    logStream.write(line + "\n");
  },
  info(...args) { this._write("INFO", args); },
  error(...args) { this._write("ERROR", args); },
  write(text) {
    process.stdout.write(text);
    logStream.write(text);
  },
};

function coerceString(val) {
  if (val == null) return "";
  if (typeof val === "string") return val;
  return String(val);
}

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len - 1) + "…" : str;
}

const SYSTEM_PROMPT = `You are an outreach copywriter for Basalt Systems, a small dev team. You write LinkedIn connection request messages to founders and directors of marketing agencies.

Write one LinkedIn connection request message. Nothing else. No commentary, no alternatives.

# Context

This message is sent alongside a LinkedIn connection request. The recipient has not yet accepted. They know nothing about Basalt Systems. The goal is to give them a reason to accept — not to pitch, not to close.

# Message structure (3 parts, in order)

1. Opening: one short sentence referencing what their agency does. Specific, not generic. If a contact name is available, use "Hi [name]," otherwise just "Hi,"
2. What we do: one sentence. Keep it natural.
3. CTA: one sentence inviting conversation, nothing more.

# Rules

- Total message length: 250 characters maximum. Count carefully.
- No subject line.
- Sound human. Write like a person, not a marketing department.
- No buzzwords: no leverage, synergy, cutting-edge, innovative, seamlessly.
- No dashes. Use commas or periods only.
- Do not mention Poland, pricing, team size, or AI.
- Do not use "I wanted to reach out" or "I hope this finds you well."
- If the message exceeds 250 characters, cut from part 2 first, then part 1. Never cut the CTA.

# Output

Return only the message. No labels, no preamble, no explanation.`;

async function generateMessage(lead) {
  const prompt = `${SYSTEM_PROMPT}\n\nLead record:\n${JSON.stringify(lead, null, 2)}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let controller;
    let timeoutId;
    try {
      controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT);

      try {
        const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt,
            stream: false,
            options: { temperature: 0.7, max_tokens: 300 },
          }),
        });

        if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);

        const data = await response.json();

        if (!data || typeof data.response !== "string") {
          throw new Error("missing or invalid response field");
        }

        const text = data.response.trim();

        if (!text) throw new Error("empty response");

        return text;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      if (err.name === "AbortError") {
        if (attempt === MAX_RETRIES) throw new Error(`Timeout after ${OLLAMA_TIMEOUT / 1000}s`);
        log.info(`  Retry ${attempt + 1}/${MAX_RETRIES} after timeout`);
      } else if (attempt === MAX_RETRIES) {
        throw err;
      } else {
        log.info(`  Retry ${attempt + 1}/${MAX_RETRIES} after error: ${err.message}`);
      }
    }
  }
}

async function run() {
  if (!MONGODB_URI || !DB_NAME) {
    throw new Error("Missing MONGODB_URI or DB_NAME");
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  log.info("Connected to MongoDB Atlas");

  const db = client.db(DB_NAME);
  const sourceCol = db.collection(COLLECTION_NAME);
  const destCol = db.collection(MESSAGES_COLLECTION);

  // Fetch all IDs from source
  const allIds = await sourceCol
    .find({}, { projection: { _id: 1 } })
    .sort({ _id: 1 })
    .toArray();
  let ids = LIMIT ? allIds.slice(0, LIMIT) : allIds;
  const totalToProcess = ids.length;

  // Resume: skip already processed
  const processedIds = new Set(
    (await destCol.find({}, { projection: { company_id: 1 } }).toArray())
      .map(d => String(d.company_id))
  );
  ids = ids.filter(({ _id }) => !processedIds.has(String(_id)));
  log.info(`Total: ${totalToProcess}, already have messages: ${totalToProcess - ids.length}, remaining: ${ids.length}\n`);

  let success = 0;
  let errors = 0;
  let n = 0;
  const padLen = String(totalToProcess).length;

  for (const { _id } of ids) {
    const record = await sourceCol.findOne({ _id });
    const title = record.title || "?";
    n++;

    log.write(`  [${String(n).padStart(padLen)}/${totalToProcess}] ${truncate(title, 40).padEnd(42)} `);

    try {
      const message = await generateMessage(record);

      await destCol.insertOne({
        company_id: _id,
        title: record.title || null,
        message,
        char_count: message.length,
        prompt_version: PROMPT_VERSION,
        ai_model: OLLAMA_MODEL,
        created_at: new Date(),
      });

      log.write(`✓ ${message.length}c\n`);
      success++;
    } catch (err) {
      log.write(`✗ ${err.message}\n`);
      errors++;
    }
  }

  const totalInDest = await destCol.countDocuments({});
  log.write(`\nDone. ${success} generated, ${errors} errors (${totalInDest} total in "${MESSAGES_COLLECTION}").\n`);
  await client.close();
}

run().catch((err) => {
  log.error(err);
  process.exit(1);
});
