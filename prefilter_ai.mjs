import { MongoClient } from "mongodb";
import fs from "node:fs";
import path from "node:path";

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME;
const COLLECTION_NAME = process.env.COLLECTION_NAME;
const RESULTS_COLLECTION = process.env.RESULTS_COLLECTION || (COLLECTION_NAME + "_filtered");
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:1.5b";
const OLLAMA_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT || "30", 10) * 1000;
const PROMPT_VERSION = process.env.PROMPT_VERSION || "v3";
const MAX_RETRIES = 3;
const LIMIT = parseInt(process.env.LIMIT || "0", 10) || 0;
const LOG_FILE = process.env.LOG_FILE || "prefilter_ai.log";

const logStream = fs.createWriteStream(path.resolve(LOG_FILE), { flags: "a" });
const log = {
  _write(level, args) {
    const msg = args.map(a => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      return JSON.stringify(a);
    }).join(" ");
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    if (level === "ERROR") {
      process.stderr.write(msg + "\n");
    } else {
      process.stdout.write(msg + "\n");
    }
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
  if (val == null || val === undefined) return "";
  if (typeof val === "string") return val;
  return String(val);
}

function coerceArray(val) {
  if (Array.isArray(val)) return val;
  if (val == null) return [];
  return [coerceString(val)];
}

function companySizeDisqualifies(size) {
  const norm = coerceString(size).toLowerCase().trim();
  if (!norm) return false;
  if (norm.includes("1 employee")) return true;
  if (norm.includes("51-200")) return true;
  if (norm.includes("201-500")) return true;
  if (norm.includes("501-1000")) return true;
  if (norm.includes("1001+")) return true;
  return false;
}

function hasWebsite(record) {
  const site = coerceString(record.website);
  return site.length > 0 && site !== "N/A";
}

async function classifyWithOllama(specialties, description) {
  const specStr = JSON.stringify(coerceArray(specialties));
  const descStr = coerceString(description) || "(none)";

  const prompt = `You are a classifier for a B2B lead generation system.
Your task: determine if the company is a "technical agency" — meaning it develops, builds, implements, automates, programs, designs, or delivers any of the following for its clients:
- websites, web applications, or web development
- software, mobile apps, or app development
- AI / artificial intelligence solutions
- chatbots or conversational AI
- automation solutions or workflow automation
- UX/UI design or UI/UX
- custom development or software engineering
- any other technical/digital implementation work

Be proactive: if the description or specialties contain even indirect hints of technical delivery (e.g. "we build", "we develop", "web design", "technical", "digital solutions", "engineering", "platform", "implementation"), return technical_agency: true.
Only return false if the company is clearly a pure marketing, advertising, PR, consulting, recruitment, or staffing agency with no technical service offering.

Return ONLY valid JSON:
{"technical_agency": true, "confidence": 0-100, "reason": "..."}
or
{"technical_agency": false, "confidence": 0-100, "reason": "..."}

"confidence" must be an integer 0-100 indicating how sure you are.

Company specialties: ${specStr}
Company description: ${descStr}`;

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
            format: "json",
            options: { temperature: 0 },
          }),
        });

        if (!response.ok) {
          throw new Error(`Ollama HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!data || typeof data.response !== "string") {
          throw new Error(`missing or invalid 'response' field in Ollama reply`);
        }

        let parsed;
        try {
          parsed = JSON.parse(data.response);
        } catch {
          throw new Error(`invalid JSON in Ollama response: ${truncate(data.response, 200)}`);
        }

        if (parsed && typeof parsed.technical_agency === "boolean") {
          return {
            technical_agency: parsed.technical_agency,
            confidence: typeof parsed.confidence === "number" ? Math.round(parsed.confidence) : null,
            reason: typeof parsed.reason === "string" ? parsed.reason : "",
          };
        }

        throw new Error(`unexpected response shape: ${truncate(JSON.stringify(parsed), 200)}`);
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      if (err.name === "AbortError") {
        if (attempt === MAX_RETRIES) {
          throw new Error(`Ollama timeout after ${OLLAMA_TIMEOUT / 1000}s (${MAX_RETRIES} retries)`);
        }
        log.info(`  Retry ${attempt + 1}/${MAX_RETRIES} after timeout`);
      } else if (attempt === MAX_RETRIES) {
        throw err;
      } else {
        log.info(`  Retry ${attempt + 1}/${MAX_RETRIES} after error: ${err.message}`);
      }
    }
  }
}

function buildResultDoc(record, status, reason, source, aiResponse) {
  const doc = {
    company_id: record._id,
    title: coerceString(record.title) || null,
    website: coerceString(record.website) || null,
    company_size: coerceString(record.company_size) || null,
    specialties: coerceArray(record.specialties),
    description: coerceString(record.description) || null,
    industry: coerceString(record.industry) || null,
    category: coerceString(record.category) || null,
    headquarters: coerceString(record.headquarters) || null,
    status,
    status_reason: reason,
    source,
    prompt_version: PROMPT_VERSION,
    ai_model: source === "ai" || source === "ai_error" ? OLLAMA_MODEL : null,
    ai_response: aiResponse || null,
    created_at: new Date(),
  };

  if (aiResponse && typeof aiResponse.reason === "string") {
    doc.ai_reason = aiResponse.reason;
  }
  if (aiResponse && typeof aiResponse.confidence === "number") {
    doc.ai_confidence = aiResponse.confidence;
  }

  return doc;
}

function fmtId(id) {
  if (!id) return "------";
  return String(id).slice(-6);
}

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len - 1) + "…" : str;
}

async function run() {
  if (!MONGODB_URI || !DB_NAME || !COLLECTION_NAME) {
    throw new Error("Missing MONGODB_URI, DB_NAME, or COLLECTION_NAME env vars");
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  log.info("Connected to MongoDB Atlas");

  const db = client.db(DB_NAME);
  const sourceCol = db.collection(COLLECTION_NAME);
  const destCol = db.collection(RESULTS_COLLECTION);

  const totalInDb = await sourceCol.countDocuments({});

  log.info(`Source collection : ${COLLECTION_NAME} (${totalInDb} docs)`);
  log.info(`Target collection : ${RESULTS_COLLECTION}`);
  log.info(`Ollama model      : ${OLLAMA_MODEL}`);
  log.info(`Ollama timeout    : ${OLLAMA_TIMEOUT / 1000}s`);
  log.info(`Limit             : ${LIMIT || "none"}`);

  // --- Before snapshot ---
  log.info("\n=== BEFORE (source) ===");
  const srcAgg = await sourceCol.aggregate([
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]).toArray();
  if (srcAgg.length > 0) {
    for (const row of srcAgg) {
      log.info(`  ${(row._id || "null").padEnd(14)} ${row.count}`);
    }
  } else {
    log.info("  (no status field set)");
  }

  const destCount = await destCol.countDocuments({});
  log.info(`\nTarget "${RESULTS_COLLECTION}" currently has ${destCount} docs`);

  // --- Ensure index exists ---
  await destCol.createIndex({ company_id: 1 }, { unique: true });

  // --- Fetch all IDs from source ---
  const allIds = await sourceCol
    .find({}, { projection: { _id: 1 } })
    .sort({ _id: 1 })
    .toArray();
  let ids = LIMIT ? allIds.slice(0, LIMIT) : allIds;
  const totalToProcess = ids.length;

  // --- Resume: skip already processed IDs ---
  const processedIds = new Set(
    (await destCol.find({}, { projection: { company_id: 1 } }).toArray())
      .map(d => String(d.company_id))
  );
  const alreadyDone = processedIds.size;
  ids = ids.filter(({ _id }) => !processedIds.has(String(_id)));
  const skipped = alreadyDone - (totalToProcess - ids.length);
  log.info(`Total in source: ${totalToProcess}, already processed: ${alreadyDone}, remaining: ${ids.length}\n`);

  const statusCounts = { disqualified: 0, linkedin: 0, email: 0, needs_review: 0 };
  const sourceCounts = { rule: 0, ai: 0, ai_error: 0 };
  let processed = 0;
  let aiCalls = 0;
  let aiErrors = 0;

  const padLen = String(totalToProcess).length;
  const previewFirst = [];
  const previewLast = [];

  for (const { _id } of ids) {
    const record = await sourceCol.findOne({ _id });
    const oldStatus = coerceString(record.status) || "—";
    let status, reason, source, aiResponse;

    const skipAi = companySizeDisqualifies(record.company_size);

    if (skipAi) {
      processed++;
      status = "disqualified";
      reason = "company size out of range";
      source = "rule";
    } else {
      const specialties = coerceArray(record.specialties);
      const description = coerceString(record.description);

      if (specialties.length > 0 || description) {
        aiCalls++;
        const num = String(++processed).padStart(padLen);
        const title = truncate(record.title || "?", 40).padEnd(42);
        log.write(`  [${num}/${totalToProcess}] ${fmtId(record._id)} ${title} `);

        const specSnippet = truncate(JSON.stringify(specialties), 80);
        const descSnippet = truncate(description.replace(/\n/g, " "), 120);
        log.write(`\n    specialties: ${specSnippet}`);
        log.write(`\n    description: ${descSnippet}`);
        log.write(`\n    ${oldStatus.padEnd(12)} → `);

        try {
          const aiResult = await classifyWithOllama(specialties, description);
          aiResponse = aiResult;

          if (aiResult.technical_agency) {
            status = "disqualified";
            reason = aiResult.reason || "technical agency detected";
          } else if (hasWebsite(record)) {
            status = "email";
            reason = "has website, run scoring agent";
          } else {
            status = "linkedin";
            reason = "no website, LinkedIn outreach only";
          }
          source = "ai";
        } catch (err) {
          aiErrors++;
          log.write(`ERROR: ${err.message}\n`);
          status = "needs_review";
          reason = "AI classification error — manual review required";
          source = "ai_error";
        }

        log.write(status + "\n");
      } else {
        processed++;
        source = "rule";
        if (hasWebsite(record)) {
          status = "email";
          reason = "has website, run scoring agent";
        } else {
          status = "linkedin";
          reason = "no website, LinkedIn outreach only";
        }
      }
    }

    const doc = buildResultDoc(record, status, reason, source, aiResponse);
    try {
      await destCol.insertOne(doc);
    } catch (insertErr) {
      if (insertErr.code === 11000) {
        log.error(`  Duplicate company_id ${fmtId(record._id)} — replacing`);
        await destCol.replaceOne({ company_id: record._id }, doc);
      } else {
        throw insertErr;
      }
    }

    statusCounts[status]++;
    sourceCounts[source]++;

    if (previewFirst.length < 5) {
      previewFirst.push(doc);
    } else {
      previewLast.push(doc);
      if (previewLast.length > 5) previewLast.shift();
    }
  }

  const totalInDest = await destCol.countDocuments({});
  log.write(`\nInserted ${processed} new docs (${totalInDest} total in "${RESULTS_COLLECTION}").\n`);
  await client.close();

  // --- After summary ---
  log.write("\n=== AFTER ===\n");
  log.info(`  Disqualified   ${statusCounts.disqualified}`);
  log.info(`  LinkedIn only  ${statusCounts.linkedin}`);
  log.info(`  Email (score)  ${statusCounts.email}`);
  log.info(`  Needs review   ${statusCounts.needs_review}`);
  log.info(`  Newly added    ${processed}`);
  log.info(`  Total in dest  ${totalInDest}`);
  log.info(`  Via rules      ${sourceCounts.rule}`);
  log.info(`  Via AI         ${sourceCounts.ai}`);
  log.info(`  AI errors      ${sourceCounts.ai_error}`);

  // --- Preview ---
  const previewAll = previewFirst.length + previewLast.length;
  if (previewAll > 0) {
    log.write(`\n=== RESULTS PREVIEW (${processed} total) ===\n`);
    for (const r of previewFirst) {
      const id = fmtId(r.company_id);
      const title = truncate(r.title || "?", 40).padEnd(42);
      const st = r.status.padEnd(14);
      const src = (r.source || "").padEnd(10);
      log.info(`  ${id} ${title} ${st} ${src} ${r.status_reason}`);
    }
    if (previewLast.length > 0 && previewFirst.length < processed) {
      log.info("  ...");
      for (const r of previewLast) {
        const id = fmtId(r.company_id);
        const title = truncate(r.title || "?", 40).padEnd(42);
        const st = r.status.padEnd(14);
        const src = (r.source || "").padEnd(10);
        log.info(`  ${id} ${title} ${st} ${src} ${r.status_reason}`);
      }
    }
  }
}

run().catch((err) => {
  log.error(err);
  process.exit(1);
});
