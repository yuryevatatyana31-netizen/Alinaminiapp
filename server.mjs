import { createServer } from "node:http";
import { readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const ROOT = resolve(".");
const WEB_DIR = join(ROOT, "web");
const STORE_PATH = join(ROOT, "data", "store.json");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

async function loadStore() {
  const raw = await readFile(STORE_PATH, "utf-8");
  return JSON.parse(raw);
}

async function saveStore(store) {
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(WEB_DIR, safePath);
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }
  if (!existsSync(filePath)) {
    return false;
  }
  const fileInfo = await stat(filePath);
  if (!fileInfo.isFile()) {
    return false;
  }
  const extension = extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[extension] || "application/octet-stream";
  const content = await readFile(filePath);
  res.writeHead(200, { "Content-Type": mimeType });
  res.end(content);
  return true;
}

async function routeApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, service: "electrologinya-miniapp" });
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    const role = url.searchParams.get("role") || "client";
    const store = await loadStore();
    return sendJson(res, 200, {
      role,
      meta: store.meta,
      now: new Date().toISOString()
    });
  }

  if (req.method === "POST" && url.pathname === "/api/dev/reset") {
    const body = await parseBody(req);
    if (body?.confirm !== "RESET") {
      return sendJson(res, 400, { ok: false, error: "RESET_CONFIRM_REQUIRED" });
    }
    const baseline = {
      meta: {
        timezone: "Europe/Moscow",
        defaultWorkStart: "08:00",
        defaultWorkEnd: "20:00",
        defaultDurationMinutes: 60
      },
      users: [],
      dayConfigs: {},
      bookings: [],
      messages: []
    };
    await saveStore(baseline);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { ok: false, error: "NOT_FOUND" });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await routeApi(req, res, url);
      return;
    }
    const served = await serveStatic(res, url.pathname);
    if (!served) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  } catch (error) {
    sendJson(res, 500, { ok: false, error: "INTERNAL_ERROR", detail: String(error) });
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Mini app server is running at http://localhost:${PORT}`);
});
