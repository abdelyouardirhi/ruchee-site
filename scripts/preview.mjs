import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

class SQLiteD1 {
  sqlite = new DatabaseSync(":memory:");
  statements = new WeakMap();

  prepare(sql) {
    /** @param {import("node:sqlite").SQLInputValue[]} values */
    const bound = (values) => {
      const statement = {
        bind: (...next) => bound(next),
        first: async () => this.execute(sql, values).results[0] ?? null,
        all: async () => this.execute(sql, values),
        run: async () => this.execute(sql, values),
      };
      this.statements.set(statement, { sql, values });
      return statement;
    };
    return bound([]);
  }

  execute(sql, values) {
    return { success: true, results: this.sqlite.prepare(sql).all(...values) };
  }

  async batch(statements) {
    // No await inside BEGIN/COMMIT: reservations remain atomic across requests.
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => {
        const stored = this.statements.get(statement);
        if (!stored) throw new Error("Unknown statement");
        return this.execute(stored.sql, stored.values);
      });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const MAX_BODY_BYTES = 200 * 1024;

function rejectRequest(req, res, status, message, headers = {}) {
  req.pause();
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Connection: "close",
    ...headers,
  });
  res.end(
    JSON.stringify({
      ok: false,
      code: status === 503 ? "unavailable" : "invalid",
      message,
      retryable: false,
    }),
    () => req.destroy(),
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const finish = (status) => {
      clearTimeout(timeout);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onError);
      if (status) {
        req.pause();
        reject(status);
      } else resolve(Buffer.concat(chunks, size));
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) finish(413);
      else chunks.push(chunk);
    };
    const onEnd = () => finish(0);
    const onError = () => finish(400);
    const timeout = setTimeout(() => finish(408), 15_000);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onError);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--live-voice")) {
    console.error(
      "Usage: node --import tsx scripts/preview.mjs [--live-voice]",
    );
    process.exitCode = 1;
    return;
  }
  const portValue = process.env.PORT ?? "4174";
  const port = Number(portValue);
  if (
    !/^[1-9][0-9]{0,4}$/u.test(portValue) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  ) {
    console.error("PORT must be an integer from 1024 to 65535.");
    process.exitCode = 1;
    return;
  }
  const limitValue = process.env.VOICE_DAILY_LIMIT ?? "5";
  const limit = Number(limitValue);
  if (
    !/^[1-9][0-9]*$/u.test(limitValue) ||
    !Number.isInteger(limit) ||
    limit > 50
  ) {
    console.error("VOICE_DAILY_LIMIT must be an integer from 1 to 50.");
    process.exitCode = 1;
    return;
  }
  const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  const dist = path.join(root, "dist");
  if ((await realpath(dist)) !== dist)
    throw new Error("Build directory must not be a symlink");
  if (!(await stat(path.join(dist, "index.html"))).isFile())
    throw new Error("Build missing");
  const [{ onRequest: recap }, { onRequest: voice }] = await Promise.all([
    import("../functions/api/recap.ts"),
    import("../functions/api/voice.ts"),
  ]);
  const db = new SQLiteD1();
  try {
    for (const migration of ["0001_recap.sql", "0002_voice.sql"]) {
      db.sqlite.exec(
        await readFile(path.join(root, "migrations", migration), "utf8"),
      );
    }
  } catch {
    db.sqlite.close();
    throw new Error("Migration unavailable");
  }
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = [...hosts].map((host) => `http://${host}`).join(",");
  const voiceKey = args.includes("--live-voice")
    ? process.env.MISTRAL_VOICE_API_KEY?.trim()
    : undefined;
  const voiceEnabled = Boolean(voiceKey);
  const sharedEnv = {
    RECAP_DB: db,
    RECAP_HASH_KEY:
      process.env.RECAP_HASH_KEY || randomBytes(32).toString("hex"),
    RECAP_ALLOWED_ORIGINS: origins,
    RECAP_EMAIL_ENABLED: "false",
  };
  // Email credentials are deliberately not loaded; the voice key only reaches voice.
  const voiceEnv = {
    ...sharedEnv,
    VOICE_ENABLED: voiceEnabled ? "true" : "false",
    VOICE_DAILY_LIMIT: String(limit),
    MISTRAL_VOICE_API_KEY: voiceKey,
  };
  let stopping = false;
  const pending = new Set();
  const server = createServer(
    { headersTimeout: 10_000, requestTimeout: 20_000 },
    (req, res) => {
      // Never log request paths, headers, bodies, names, email addresses or audio.
      const task = handle(req, res)
        .catch(() => {
          if (!res.headersSent && !res.destroyed)
            rejectRequest(req, res, 500, "Demande impossible pour le moment.");
          else res.destroy();
        })
        .finally(() => pending.delete(task));
      pending.add(task);
    },
  );

  async function handle(req, res) {
    if (stopping)
      return rejectRequest(req, res, 503, "Serveur local indisponible.");
    if (!hosts.has(req.headers.host))
      return rejectRequest(req, res, 403, "Adresse invalide.");
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) {
      return rejectRequest(req, res, 400, "Adresse invalide.");
    }
    let pathname;
    let url;
    try {
      // Decode before resolution, rather than letting URL normalize traversal away.
      pathname = decodeURIComponent(req.url.split("?")[0]);
      if (/[\u0000-\u001f\u007f\\#]/u.test(pathname))
        throw new Error("Invalid path");
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch {
      return rejectRequest(req, res, 400, "Adresse invalide.");
    }
    if (pathname === "/api/recap" || pathname === "/api/voice") {
      if (req.method !== "POST")
        return rejectRequest(req, res, 405, "Utilisez POST.", {
          Allow: "POST",
        });
      if (req.headers.origin !== url.origin)
        return rejectRequest(req, res, 400, "Origine invalide.");
      if (pathname === "/api/voice" && !voiceEnabled) {
        return rejectRequest(
          req,
          res,
          503,
          "La voix est indisponible pour le moment.",
        );
      }
      let body;
      try {
        body = await readBody(req);
      } catch (status) {
        return rejectRequest(req, res, status, "Demande invalide.");
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined)
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      headers.delete("transfer-encoding");
      headers.delete("content-length");
      // Loopback-only preview, not a production proxy or trustworthy client IP source.
      headers.set("CF-Connecting-IP", "127.0.0.1");
      const request = new Request(url, { method: "POST", headers, body });
      const response =
        pathname === "/api/recap"
          ? await recap({ request, env: sharedEnv })
          : await voice({ request, env: voiceEnv });
      if (res.destroyed) return;
      const bytes = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(bytes);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return rejectRequest(req, res, 405, "Utilisez GET ou HEAD.", {
        Allow: "GET, HEAD",
      });
    }
    const segments = pathname.split("/");
    if (
      segments.some(
        (segment) =>
          segment.startsWith(".") ||
          segment.startsWith("_") ||
          [
            "functions",
            "migrations",
            "node_modules",
            "scripts",
            "tests",
          ].includes(segment),
      )
    ) {
      return rejectRequest(req, res, 404, "Introuvable.");
    }
    const file = path.resolve(
      dist,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    if (!file.startsWith(`${dist}${path.sep}`))
      return rejectRequest(req, res, 404, "Introuvable.");
    const type = MIME[path.extname(file).toLowerCase()];
    if (!type) return rejectRequest(req, res, 404, "Introuvable.");
    let info;
    try {
      const canonical = await realpath(file);
      if (!canonical.startsWith(`${dist}${path.sep}`) || canonical !== file) {
        return rejectRequest(req, res, 404, "Introuvable.");
      }
      info = await stat(file);
      if (!info.isFile()) return rejectRequest(req, res, 404, "Introuvable.");
    } catch {
      return rejectRequest(req, res, 404, "Introuvable.");
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": info.size,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") res.end();
    else await pipeline(createReadStream(file), res);
  }

  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      clearTimeout(deadline);
      // Provider handlers have their own bounded deadlines. Keep D1 open until
      // their final reservation updates complete, even if a browser disconnected.
      void Promise.allSettled([...pending]).then(() => db.sqlite.close());
    });
    // Allow in-flight handlers to finish, then stop remaining local connections.
    const deadline = setTimeout(() => server.closeAllConnections(), 2_000);
    deadline.unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.once("error", () => {
    console.error("Preview could not listen on the configured loopback port.");
    process.exitCode = 1;
    stop();
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(
      `Preview: http://127.0.0.1:${port} (also http://localhost:${port})`,
    );
    console.log(
      `Voice: ${voiceEnabled ? "enabled on explicit browser submission" : "disabled"}; email: disabled.`,
    );
    console.log(
      `In-memory quotas reset on every restart. Voice daily limit: ${limit} per action; per-IP cap: 5/hour/action. No startup provider requests.`,
    );
  });
}

main().catch(() => {
  console.error(
    "Preview setup failed. Build dist and provide both API handlers/migrations; run with Node 22 and --import tsx.",
  );
  process.exitCode = 1;
});
