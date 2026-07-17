import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = parseInt(process.env.API_PORT || "3457", 10);
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";
const MODEL_TEXT = process.env.OLLAMA_MODEL_TEXT || MODEL;
const MODEL_FUNCTION = process.env.OLLAMA_MODEL_FUNCTION || MODEL;
const MODEL_VIDEO = process.env.OLLAMA_MODEL_VIDEO || MODEL;
const MODEL_MAP = {
  text: MODEL_TEXT,
  video: MODEL_VIDEO,
};
const sessions = new Map();
const functions = new Map();
const DEBUG_LOG = path.resolve("debug.log");

function log(obj) {
  const line = JSON.stringify({ time: Math.floor(Date.now() / 1000), ...obj }) + "\n";
  fs.appendFileSync(DEBUG_LOG, line, "utf-8");
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

async function askOllama(model, messages) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama error (${res.status}): ${errText}`);
  }
  return res.json();
}

function matchRoute(method, pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (method === "POST" && pathname === "/api/function") return { handler: "registerFunction" };
  if (method === "GET" && pathname === "/api/function") return { handler: "listFunctions" };
  if (method === "DELETE" && parts[0] === "api" && parts[1] === "function" && parts[2]) {
    return { handler: "deleteFunction", name: parts[2] };
  }
  if (method === "POST" && pathname === "/api/ask") return { handler: "ask" };
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const route = matchRoute(req.method, pathname);

  if (!route) {
    json(res, 404, { error: "Not found" });
    return;
  }

  if (route.handler === "registerFunction") {
    let data;
    try { data = await body(req); }
    catch { json(res, 400, { error: "Invalid JSON body" }); return; }

    const { name, description, parameters } = data || {};
    if (!name || !description) {
      json(res, 400, { error: "Both name and description are required" });
      return;
    }

    functions.set(name, { name, description, parameters: parameters || {} });
    log({ event: "function_register", name });
    json(res, 201, { ok: true, function: functions.get(name) });
    return;
  }

  if (route.handler === "listFunctions") {
    json(res, 200, { functions: [...functions.values()] });
    return;
  }

  if (route.handler === "deleteFunction") {
    if (!functions.has(route.name)) {
      json(res, 404, { error: `Function "${route.name}" not found` });
      return;
    }
    functions.delete(route.name);
    log({ event: "function_delete", name: route.name });
    json(res, 200, { ok: true });
    return;
  }

  if (route.handler === "ask") {
    let data;
    try { data = await body(req); }
    catch { json(res, 400, { error: "Invalid JSON body" }); return; }

    const { type, system_prompt, user_message, session_id } = data || {};
    if (!system_prompt || !user_message) {
      json(res, 400, { error: "Both system_prompt and user_message are required" });
      return;
    }

    const t = type || "text";
    const model = MODEL_MAP[t] || MODEL;

    log({ event: "request", model, type: t, system_prompt, user_message, session_id: session_id || null });

    if (t === "function_calling") {
      if (functions.size === 0) {
        json(res, 200, {
          model: null,
          message: { role: "assistant", content: JSON.stringify({ function: null, parameters: {}, endpoints: { list: "GET /api/function", create: "POST /api/function { name, description, parameters? }", delete: "DELETE /api/function/:name" } }) },
          done: true,
        });
        return;
      }

      const funcList = [...functions.values()].map(f => {
        let desc = `"${f.name}": ${f.description}`;
        if (f.parameters && Object.keys(f.parameters).length > 0) {
          desc += `, parameters: ${JSON.stringify(f.parameters)}`;
        }
        return desc;
      }).join("\n");

      const fcSystemPrompt = `${system_prompt}\n\nAvailable functions:\n${funcList}\n\nBased on the user message, select the most relevant function and respond with ONLY valid JSON in this format: {"function": "function_name", "parameters": {...}}. Do not add any other text. If no function matches, respond with {"function": null, "parameters": {}}.`;

      try {
        const result = await askOllama(MODEL_FUNCTION, [
          { role: "system", content: fcSystemPrompt },
          { role: "user", content: user_message },
        ]);
        log({ event: "response", model: result.model, content: result.message.content, done: result.done });
        const parsed = (() => { try { return JSON.parse(result.message.content); } catch { return null; } })();
        if (parsed && parsed.function === null) {
          json(res, 200, { model: result.model, message: { role: "assistant", content: JSON.stringify({ function: null, parameters: {}, endpoints: { list: "GET /api/function", create: "POST /api/function { name, description, parameters? }", delete: "DELETE /api/function/:name" } }) }, done: result.done });
        } else {
          json(res, 200, { model: result.model, message: result.message, done: result.done });
        }
      } catch (err) {
        log({ event: "error", error: err.message });
        json(res, 502, { error: err.message });
      }
      return;
    }

    let messages;
    if (session_id) {
      if (!sessions.has(session_id)) {
        sessions.set(session_id, [{ role: "system", content: system_prompt }]);
      }
      const history = sessions.get(session_id);
      history.push({ role: "user", content: user_message });
      messages = history;
    } else {
      messages = [
        { role: "system", content: system_prompt },
        { role: "user", content: user_message },
      ];
    }

    try {
      const result = await askOllama(model, messages);

      if (session_id) {
        const history = sessions.get(session_id);
        history.push(result.message);
      }

      log({ event: "response", model: result.model, content: result.message.content, done: result.done });

      json(res, 200, {
        model: result.model,
        message: result.message,
        done: result.done,
      });
    } catch (err) {
      log({ event: "error", error: err.message });
      json(res, 502, { error: err.message });
    }
    return;
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Ollama proxy: http://0.0.0.0:${PORT}`);
  console.log(`  POST /api/ask        — { type?, system_prompt, user_message, session_id? }`);
  console.log(`  POST /api/function   — { name, description, parameters? }`);
  console.log(`  GET  /api/function   — list registered functions`);
  console.log(`  DELETE /api/function/:name — delete a function`);
  console.log(`  Models — text: ${MODEL_TEXT}, function: ${MODEL_FUNCTION}, video: ${MODEL_VIDEO}`);
});
