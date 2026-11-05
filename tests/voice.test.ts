import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import {
  personalizedReply,
  TTS_MODEL,
  TRANSCRIBE_MODEL,
  VOICE_ID,
} from "../chat-content.js";
import type {
  D1Database,
  D1Result,
  D1Statement,
  Env,
} from "../functions/api/recap.js";
import { onRequest } from "../functions/api/voice.js";

const ORIGIN = "https://ruchee.example";
const HASH_KEY = "test-only-hmac-key-with-at-least-32-characters";
const START = Date.parse("2026-11-05T12:00:00Z");
const MP3 = Uint8Array.of(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0);
const migration = readFileSync(
  new URL("../migrations/0002_voice.sql", import.meta.url),
  "utf8",
);
type Action = "greet" | "transcribe";
interface Row {
  id: string;
  action: Action;
  fingerprint: string;
  ip_hash: string;
  created_at: number;
  state: string;
}

// Real SQL and synchronous transactions reproduce D1's atomic batch semantics.
class SQLiteD1 implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  readonly operations: { sql: string; values: (string | number)[] }[] = [];
  failBatch = false;
  failRead = false;
  failUpdate = false;
  unsuccessfulBatch = false;
  private readonly statements = new WeakMap<
    D1Statement,
    { sql: string; values: (string | number)[] }
  >();
  constructor() {
    this.sqlite.exec(migration);
  }
  prepare(sql: string): D1Statement {
    const tracked = (values: (string | number)[]): D1Statement => {
      const statement: D1Statement = {
        bind: (...next) => tracked(next),
        first: async <T>() => this.execute<T>(sql, values).results[0] ?? null,
        all: async <T>() => this.execute<T>(sql, values),
        run: async () => this.execute(sql, values),
      };
      this.statements.set(statement, { sql, values });
      return statement;
    };
    return tracked([]);
  }
  private execute<T>(sql: string, values: (string | number)[]): D1Result<T> {
    this.operations.push({ sql, values });
    if (
      (this.failUpdate && sql.startsWith("UPDATE")) ||
      (this.failRead && sql.startsWith("SELECT"))
    )
      throw new Error("Storage unavailable");
    return {
      success: true,
      results: this.sqlite.prepare(sql).all(...values) as T[],
    };
  }
  async batch<T>(statements: D1Statement[]): Promise<D1Result<T>[]> {
    if (this.failBatch) throw new Error("Storage unavailable");
    if (this.unsuccessfulBatch)
      return [
        { success: false, results: [] },
        { success: false, results: [] },
      ];
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => {
        const stored = this.statements.get(statement);
        assert.ok(stored);
        return this.execute<T>(stored.sql, stored.values);
      });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  rows(): Row[] {
    return this.sqlite
      .prepare("SELECT * FROM voice_requests")
      .all() as unknown as Row[];
  }
}

function payload(overrides: Record<string, unknown> = {}) {
  return { name: "Jeanne", requestId: randomUUID(), website: "", ...overrides };
}

function wav(length = 6400, silent = false): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + length);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) =>
    bytes.set(new TextEncoder().encode(text), at);
  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, length, true);
  if (!silent)
    for (let i = 44; i + 1 < bytes.length; i += 2)
      view.setInt16(i, (i % 1000) - 500, true);
  return bytes;
}

function request(
  action: string = "greet",
  body?: BodyInit | null,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Request {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    duplex: "half",
    signal,
    headers: {
      origin: ORIGIN,
      "cf-connecting-ip": "192.0.2.1",
      "content-type": action === "greet" ? "application/json" : "audio/wav",
      ...(action === "transcribe"
        ? { "x-voice-request-id": randomUUID() }
        : {}),
      ...headers,
    },
    body:
      body === undefined
        ? action === "greet"
          ? JSON.stringify(payload())
          : wav()
        : body,
  };
  return new Request(`${ORIGIN}/api/voice?action=${action}`, init);
}

function fixture(t: TestContext) {
  const db = new SQLiteD1();
  const clock = { now: START };
  t.mock.method(Date, "now", () => clock.now);
  const env: Env = {
    VOICE_ENABLED: "true",
    MISTRAL_VOICE_API_KEY: "test-only-direct-voice-key",
    RECAP_HASH_KEY: HASH_KEY,
    RECAP_ALLOWED_ORIGINS: `${ORIGIN}, https://other.example`,
    RECAP_DB: db,
  };
  const calls: { action: Action; init: RequestInit }[] = [];
  const provider = {
    respond: async (action: Action, _init: RequestInit): Promise<Response> =>
      action === "greet"
        ? Response.json({ audio_data: Buffer.from(MP3).toString("base64") })
        : Response.json({ text: "Je m'appelle Jeanne." }),
  };
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      assert.ok(init);
      assert.ok(
        url === "https://api.mistral.ai/v1/audio/speech" ||
          url === "https://api.mistral.ai/v1/audio/transcriptions",
      );
      const action = String(url).endsWith("/speech") ? "greet" : "transcribe";
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(
        new Headers(init.headers).get("authorization"),
        `Bearer ${env.MISTRAL_VOICE_API_KEY}`,
      );
      assert.ok(init.signal instanceof AbortSignal);
      assert.ok(
        db
          .rows()
          .some((row) => row.action === action && row.state === "pending"),
      );
      calls.push({ action, init });
      return provider.respond(action, init);
    },
  );
  t.after(() => {
    t.mock.restoreAll();
    db.sqlite.close();
  });
  const send = (req: Request = request()) => onRequest({ request: req, env });
  const greet = (
    data: unknown = payload(),
    headers: Record<string, string> = {},
  ) => send(request("greet", JSON.stringify(data), headers));
  const transcribe = (bytes = wav(), headers: Record<string, string> = {}) =>
    send(request("transcribe", bytes, headers));
  return { db, clock, env, calls, provider, send, greet, transcribe };
}

async function expectReply(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json/u,
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["code", "message", "ok"]);
  assert.equal(body.ok, false);
  assert.equal(body.code, code);
  assert.equal(typeof body.message, "string");
  assert.doesNotMatch(
    String(body.message),
    /test-only|provider-secret|192\.0\.2|Jeanne/u,
  );
}

async function expectAudio(response: Response, bytes: Uint8Array = MP3) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
}

async function expectName(response: Response, name = "Jeanne") {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, name });
}

test(
  "voice backend (serial mocked providers, real SQLite)",
  { concurrency: false },
  async (t) => {
    await t.test(
      "missing configuration, dedicated key only, hard capped limits and exact origin list",
      async (t) => {
        const { env, db, calls } = fixture(t);
        const invalid: Partial<Env>[] = [
          ...[
            "VOICE_ENABLED",
            "MISTRAL_VOICE_API_KEY",
            "RECAP_HASH_KEY",
            "RECAP_ALLOWED_ORIGINS",
            "RECAP_DB",
          ].map((key) => ({ [key]: undefined })),
          { VOICE_ENABLED: "false" },
          { VOICE_ENABLED: "TRUE" },
          { MISTRAL_VOICE_API_KEY: " " },
          { RECAP_HASH_KEY: "x".repeat(31) },
          { RECAP_HASH_KEY: " ".repeat(32) },
          ...["0", "51", "-1", "1.5", "no", "", "Infinity", " 2"].map(
            (VOICE_DAILY_LIMIT) => ({ VOICE_DAILY_LIMIT }),
          ),
          ...[
            "*",
            `${ORIGIN},*`,
            `${ORIGIN},`,
            `${ORIGIN}/`,
            "null",
            "https://*.example",
            "https://user:pass@ruchee.example",
          ].map((RECAP_ALLOWED_ORIGINS) => ({ RECAP_ALLOWED_ORIGINS })),
        ];
        for (const action of ["greet", "transcribe"]) {
          for (const override of invalid)
            await expectReply(
              await onRequest({
                request: request(action),
                env: { ...env, ...override },
              }),
              503,
              "unavailable",
            );
          const noIp = request(action, undefined, {
            "x-forwarded-for": "192.0.2.1",
            "x-real-ip": "192.0.2.1",
          });
          noIp.headers.delete("cf-connecting-ip");
          await expectReply(
            await onRequest({ request: noIp, env }),
            503,
            "unavailable",
          );
        }
        const textEnv = {
          ...env,
          MISTRAL_VOICE_API_KEY: undefined,
          MISTRAL_API_KEY: "text-secret",
          MISTRAL_SERVER_URL: "https://azure.example",
        };
        await expectReply(
          await onRequest({ request: request(), env: textEnv }),
          503,
          "unavailable",
        );
        assert.equal(db.operations.length, 0);
        assert.equal(calls.length, 0);
      },
    );

    await t.test("method, action and both origin checks", async (t) => {
      const { env, send, db, calls } = fixture(t);
      for (const method of ["GET", "PUT", "OPTIONS", "DELETE"]) {
        const response = await send(
          new Request(`${ORIGIN}/api/voice?action=greet`, { method }),
        );
        assert.equal(response.headers.get("allow"), "POST");
        await expectReply(response, 405, "invalid");
      }
      for (const action of [
        "",
        "welcome",
        "chat",
        "GREET",
        "greet&action=transcribe",
      ])
        await expectReply(await send(request(action)), 400, "invalid");
      for (const action of ["greet", "transcribe"]) {
        for (const origin of [
          "",
          "null",
          "https://attacker.example",
          "https://other.example",
          `${ORIGIN}/`,
        ])
          await expectReply(
            await send(request(action, undefined, { origin })),
            400,
            "invalid",
          );
      }
      env.RECAP_ALLOWED_ORIGINS = "https://other.example";
      await expectReply(await send(), 400, "invalid");
      assert.equal(db.operations.length, 0);
      assert.equal(calls.length, 0);
    });

    await t.test(
      "greet strict payload, arbitrary text, honeypot, name and UUID guards",
      async (t) => {
        const { greet, send, db, calls } = fixture(t);
        const invalid: unknown[] = [null, [], "text", 42, {}];
        for (const field of [
          "input",
          "text",
          "model",
          "voice_id",
          "expressiveness",
          "email",
          "scenario",
          "prompt",
          "messages",
        ])
          invalid.push(payload({ [field]: "attacker-controlled" }));
        for (const name of [
          null,
          "",
          " ",
          "-",
          "Jean3",
          "a".repeat(61),
          "<Jean>",
          "Jean\n",
          "Jean\u0000",
          "Jean\u200b",
          "Jean\u202e",
        ])
          invalid.push(payload({ name }));
        for (const website of ["spam", " ", false, null])
          invalid.push(payload({ website }));
        for (const requestId of [
          "bad",
          "00000000-0000-0000-0000-000000000000",
          "12345678-1234-1234-8123-123456789abc",
          "12345678-1234-4234-7123-123456789abc",
          null,
        ])
          invalid.push(payload({ requestId }));
        for (const key of ["name", "requestId", "website"]) {
          const data: Record<string, unknown> = payload();
          delete data[key];
          invalid.push(data);
        }
        for (const data of invalid)
          await expectReply(await greet(data), 400, "invalid");
        for (const body of ["{", "", new Uint8Array([0xff])])
          await expectReply(await send(request("greet", body)), 400, "invalid");
        for (const type of [
          "",
          "text/plain",
          "audio/wav",
          "application/x-www-form-urlencoded",
        ])
          await expectReply(
            await send(request("greet", undefined, { "content-type": type })),
            400,
            "invalid",
          );
        await expectReply(await send(request("greet", null)), 400, "invalid");
        assert.equal(db.operations.length, 0);
        assert.equal(calls.length, 0);
      },
    );

    await t.test(
      "actual byte limits cancel oversized streams without trusting Content-Length",
      async (t) => {
        const { send, db, calls } = fixture(t);
        for (const action of ["greet", "transcribe"] as const) {
          const max = action === "greet" ? 1024 : 192044;
          let cancelled = false;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(max));
              controller.enqueue(Uint8Array.of(1));
            },
            cancel() {
              cancelled = true;
              return new Promise(() => {});
            },
          });
          await expectReply(
            await send(request(action, stream, { "content-length": "1" })),
            400,
            "invalid",
          );
          assert.equal(cancelled, true);
          const broken = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("broken"));
            },
          });
          await expectReply(
            await send(request(action, broken)),
            400,
            "invalid",
          );
        }
        const oversized =
          JSON.stringify(payload({ name: "É".repeat(60) })) + " ".repeat(1024);
        await expectReply(
          await send(request("greet", oversized)),
          400,
          "invalid",
        );
        assert.equal(calls.length, 0);
        assert.equal(db.operations.length, 0);
        const data = JSON.stringify(payload());
        await expectAudio(
          await send(
            request("greet", data + " ".repeat(1024 - Buffer.byteLength(data))),
          ),
        );
        await expectName(
          await send(
            request("transcribe", wav(192000), { "content-length": "1" }),
          ),
        );
        assert.equal(calls.length, 2);
      },
    );

    for (const action of ["greet", "transcribe"] as const) {
      for (const stop of [
        "deadline",
        "client abort",
        "already aborted",
      ] as const) {
        await t.test(
          `${action} upload ${stop} cancels before SQL or fetch`,
          async (t) => {
            const { send, db, calls } = fixture(t);
            t.mock.timers.enable({ apis: ["setTimeout"] });
            const scheduled = t.mock.method(globalThis, "setTimeout");
            const cleared = t.mock.method(globalThis, "clearTimeout");
            const fetch = t.mock.method(globalThis, "fetch");
            const prepare = t.mock.method(db, "prepare");
            const batch = t.mock.method(db, "batch");
            const logs: unknown[][] = [];
            for (const method of [
              "log",
              "info",
              "warn",
              "error",
              "debug",
            ] as const)
              t.mock.method(console, method, (...args: unknown[]) => {
                logs.push(args);
              });
            const client = new AbortController();
            let started!: () => void;
            const reached = new Promise<void>((resolve) => {
              started = resolve;
            });
            let source!: ReadableStreamDefaultController<Uint8Array>;
            let cancelled = 0;
            const stream = new ReadableStream<Uint8Array>(
              {
                start(controller) {
                  source = controller;
                  controller.enqueue(
                    action === "greet"
                      ? new TextEncoder().encode('{"name":"Jeanne"')
                      : wav().subarray(0, 44),
                  );
                },
                pull() {
                  started();
                },
                cancel() {
                  cancelled++;
                  // Cancellation must not wait for an uncooperative source.
                  return new Promise<void>(() => {});
                },
              },
              { highWaterMark: 0 },
            );
            const req = request(action, stream, {}, client.signal);
            if (stop === "already aborted")
              client.abort(new Error("Jeanne 192.0.2.1"));
            let settled = false;
            const pending = send(req).then((response) => {
              settled = true;
              return response;
            });
            if (stop !== "already aborted") {
              await reached;
              t.mock.timers.tick(9000);
              source.enqueue(Uint8Array.of(32));
              await Promise.resolve();
              t.mock.timers.tick(999);
              assert.equal(settled, false);
              assert.equal(cancelled, 0);
              if (stop === "deadline") t.mock.timers.tick(1);
              else client.abort(new Error("Jeanne 192.0.2.1"));
            }
            await expectReply(await pending, 400, "invalid");
            assert.equal(cancelled, 1);
            assert.equal(stream.locked, false);
            assert.deepEqual(getEventListeners(req.signal, "abort"), []);
            assert.equal(scheduled.mock.callCount(), 1);
            assert.equal(scheduled.mock.calls[0].arguments[1], 10000);
            assert.deepEqual(
              cleared.mock.calls.map((call) => call.arguments[0]),
              [scheduled.mock.calls[0].result],
            );
            t.mock.timers.tick(20000);
            client.abort();
            assert.equal(cancelled, 1);
            assert.equal(fetch.mock.callCount(), 0);
            assert.equal(prepare.mock.callCount(), 0);
            assert.equal(batch.mock.callCount(), 0);
            assert.equal(calls.length, 0);
            assert.deepEqual(db.operations, []);
            assert.deepEqual(db.rows(), []);
            assert.deepEqual(logs, []);
          },
        );
      }
    }

    await t.test(
      "upload cleanup on success, malformed, oversized and broken bodies",
      async (t) => {
        const { send } = fixture(t);
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const scheduled = t.mock.method(globalThis, "setTimeout");
        const cleared = t.mock.method(globalThis, "clearTimeout");
        for (const action of ["greet", "transcribe"] as const) {
          for (const outcome of [
            "success",
            "malformed",
            "oversized",
            "broken",
          ] as const) {
            let cancelled = 0;
            const client = new AbortController();
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                if (outcome === "broken") controller.error(new Error("broken"));
                else if (outcome === "oversized")
                  controller.enqueue(
                    new Uint8Array(action === "greet" ? 1025 : 192045),
                  );
                else {
                  controller.enqueue(
                    outcome === "malformed"
                      ? Uint8Array.of(0xff)
                      : action === "greet"
                        ? new TextEncoder().encode(JSON.stringify(payload()))
                        : wav(),
                  );
                  controller.close();
                }
              },
              cancel() {
                cancelled++;
                return Promise.reject(new Error("cancel failed"));
              },
            });
            const req = request(action, stream, {}, client.signal);
            const response = await send(req);
            if (outcome !== "success")
              await expectReply(response, 400, "invalid");
            else if (action === "greet") await expectAudio(response);
            else await expectName(response);
            assert.equal(stream.locked, false);
            assert.deepEqual(getEventListeners(req.signal, "abort"), []);
            client.abort();
            t.mock.timers.tick(30000);
            assert.equal(cancelled, outcome === "oversized" ? 1 : 0);
          }
        }
        assert.deepEqual(
          cleared.mock.calls.map((call) => call.arguments[0]),
          scheduled.mock.calls.map((call) => call.result),
        );
      },
    );

    await t.test(
      "greet uses only normalized fixed speech and the direct Manon MP3 contract",
      async (t) => {
        const { greet, calls, db } = fixture(t);
        await expectAudio(
          await greet(payload({ name: "  Éloïse D’Arcy-Andre\u0301  " })),
        );
        assert.equal(calls.length, 1);
        assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
          model: TTS_MODEL,
          input: personalizedReply("Éloïse D’Arcy-André"),
          voice_id: VOICE_ID,
          expressiveness: 3,
          response_format: "mp3",
          stream: false,
        });
        assert.deepEqual(
          [...new Headers(calls[0].init.headers)],
          [
            ["authorization", "Bearer test-only-direct-voice-key"],
            ["content-type", "application/json"],
          ],
        );
        assert.equal(db.rows()[0].state, "done");
        await expectAudio(await greet(payload({ name: "é".repeat(60) })));
        assert.ok(
          [...JSON.parse(String(calls[1].init.body)).input].length <= 240,
        );
      },
    );

    await t.test(
      "TTS accepts plausible frame sync and exactly 512 KiB, rejects invalid base64/audio/MIME",
      async (t) => {
        const { greet, provider, db, calls } = fixture(t);
        for (const bytes of [
          Uint8Array.of(0xff, 0xfb, 0x90, 0),
          new Uint8Array(512 * 1024),
        ]) {
          if (bytes.length > 4) bytes.set(MP3);
          provider.respond = async () =>
            Response.json({
              audio_data: Buffer.from(bytes).toString("base64"),
            });
          await expectAudio(await greet(), bytes);
        }
        const tooBig = new Uint8Array(512 * 1024 + 1);
        tooBig.set(MP3);
        const invalid: (() => Promise<Response>)[] = [
          ...[
            null,
            [],
            {},
            { audio_data: 12 },
            { audio_data: "" },
            { audio_data: "%%%=" },
            { audio_data: "SUR=" },
            { audio_data: "SUR" },
            { audio_data: "SURB\n" },
            { audio_data: "SUQzAB==" },
            { audio_data: "data:audio/mpeg;base64,SURB" },
            { audio_data: Buffer.from("not an MP3").toString("base64") },
            { audio_data: Buffer.from(tooBig).toString("base64") },
          ].map((body) => async () => Response.json(body)),
          async () =>
            new Response("{", {
              headers: { "Content-Type": "application/json" },
            }),
          async () =>
            new Response(MP3, { headers: { "Content-Type": "audio/mpeg" } }),
          async () =>
            new Response(
              JSON.stringify({
                audio_data: Buffer.from(MP3).toString("base64"),
              }),
              { headers: { "Content-Type": "text/html" } },
            ),
          async () => new Response(null, { status: 204 }),
        ];
        for (const [i, respond] of invalid.entries()) {
          provider.respond = respond;
          const data = payload();
          const headers = { "cf-connecting-ip": `192.0.2.${i + 10}` };
          await expectReply(await greet(data, headers), 503, "unavailable");
          await expectReply(await greet(data, headers), 409, "already_used");
        }
        assert.equal(calls.length, invalid.length + 2);
        assert.ok(
          db
            .rows()
            .slice(2)
            .every((row) => row.state === "unknown"),
        );
      },
    );

    await t.test(
      "canonical WAV rejects altered headers, extra chunks, fake durations and silence before SQL",
      async (t) => {
        const { transcribe, send, db, calls } = fixture(t);
        for (const [offset, value, width] of [
          [0, 0, 4],
          [4, 1, 4],
          [8, 0, 4],
          [12, 0, 4],
          [16, 18, 4],
          [20, 3, 2],
          [20, 6, 2],
          [22, 2, 2],
          [24, 48000, 4],
          [28, 1, 4],
          [32, 4, 2],
          [34, 8, 2],
          [36, 0, 4],
          [40, 192000, 4],
        ]) {
          const bytes = wav();
          const view = new DataView(bytes.buffer);
          if (width === 2) view.setUint16(offset, value, true);
          else view.setUint32(offset, value, true);
          await expectReply(await transcribe(bytes), 400, "invalid");
        }
        for (const bytes of [
          new Uint8Array(),
          wav().slice(0, 43),
          wav(0),
          wav(6398),
          wav(6401),
          wav(192002),
          new Uint8Array([...wav(), 0, 0]),
        ])
          await expectReply(await transcribe(bytes), 400, "invalid");
        const bigEndian = wav();
        new DataView(bigEndian.buffer).setUint32(24, 16000, false);
        await expectReply(await transcribe(bigEndian), 400, "invalid");
        const extraChunk = wav(6412);
        extraChunk.set(new TextEncoder().encode("JUNK"), 36);
        await expectReply(await transcribe(extraChunk), 400, "invalid");
        await expectReply(
          await transcribe(wav(6400, true)),
          422,
          "unrecognized",
        );
        await expectReply(
          await transcribe(wav(192000, true)),
          422,
          "unrecognized",
        );
        for (const type of ["", "audio/webm", "audio/mpeg", "application/json"])
          await expectReply(
            await transcribe(wav(), { "content-type": type }),
            400,
            "invalid",
          );
        for (const id of [
          "",
          "bad",
          "00000000-0000-0000-0000-000000000000",
          "12345678-1234-1234-8123-123456789abc",
        ])
          await expectReply(
            await transcribe(wav(), { "x-voice-request-id": id }),
            400,
            "invalid",
          );
        const missingId = request("transcribe");
        missingId.headers.delete("x-voice-request-id");
        await expectReply(await send(missingId), 400, "invalid");
        await expectReply(
          await transcribe(wav(), { "x-voice-website": "spam" }),
          400,
          "invalid",
        );
        assert.equal(db.operations.length, 0);
        assert.equal(calls.length, 0);
        await expectName(
          await transcribe(wav(6400), { "x-voice-website": "" }),
        );
        await expectName(await transcribe(wav(192000)));
      },
    );

    await t.test(
      "STT sends only fixed model and original canonical WAV file, never a prompt or chat request",
      async (t) => {
        const { transcribe, calls } = fixture(t);
        const bytes = wav();
        await expectName(await transcribe(bytes));
        const init = calls[0].init;
        assert.deepEqual(
          [...new Headers(init.headers)],
          [["authorization", "Bearer test-only-direct-voice-key"]],
        );
        assert.ok(init.body instanceof FormData);
        assert.deepEqual([...init.body.keys()].sort(), ["file", "model"]);
        assert.equal(init.body.get("model"), TRANSCRIBE_MODEL);
        const file = init.body.get("file");
        assert.ok(file instanceof File);
        assert.equal(file.name, "prenom.wav");
        assert.equal(file.type, "audio/wav");
        assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
      },
    );

    await t.test(
      "STT strips only known prefixes, normalizes names and rejects ambiguous transcripts",
      async (t) => {
        const { transcribe, provider, db } = fixture(t);
        const valid = [
          ["Jeanne", "Jeanne"],
          ["Bonjour Jeanne.", "Jeanne"],
          ["Bonjour, je m’appelle Éloïse.", "Éloïse"],
          ["je m'appelle Jeanne!", "Jeanne"],
          ["moi c’est Jean-Pierre.", "Jean-Pierre"],
          ["mon prénom est André.", "André"],
          ["Je suis Marie Claire.", "Marie Claire"],
          ["c'est D’Arcy.", "D’Arcy"],
          ["  Andre\u0301...  ", "André"],
          ["محمد", "محمد"],
        ];
        for (const [i, [text, name]] of valid.entries()) {
          provider.respond = async () =>
            Response.json({
              text,
              segments: ["must not return full transcript"],
            });
          await expectName(
            await transcribe(wav(), {
              "cf-connecting-ip": `192.0.2.${i + 10}`,
            }),
            name,
          );
        }
        for (const [i, text] of [
          "",
          "Bonjour",
          "Je m'appelle",
          "Jean ou Paul",
          "Jean et Paul",
          "Jean, Paul",
          "Je suis Jean et je voudrais un devis",
          "merci",
          "oui",
          "non",
          "Jean 42",
          "<Jean>",
          "Jean\u202e",
          "a".repeat(61),
          "a".repeat(201),
          "un deux trois quatre cinq",
          "Je ne sais pas",
          "Jean? Paul?",
        ].entries()) {
          provider.respond = async () => Response.json({ text });
          await expectReply(
            await transcribe(wav(), {
              "cf-connecting-ip": `192.0.2.${i + 50}`,
            }),
            422,
            "unrecognized",
          );
        }
        assert.ok(db.rows().every((row) => row.state === "done"));
      },
    );

    await t.test(
      "provider JSON bodies are stream-bounded at 1 MiB and 64 KiB",
      async (t) => {
        const { send, provider, db } = fixture(t);
        for (const action of ["greet", "transcribe"] as const) {
          const max = action === "greet" ? 1024 * 1024 : 64 * 1024;
          let cancelled = false;
          provider.respond = async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array(max));
                  controller.enqueue(Uint8Array.of(0));
                },
                cancel() {
                  cancelled = true;
                  return new Promise(() => {});
                },
              }),
              {
                headers: {
                  "Content-Type": "application/json",
                  "Content-Length": "1",
                },
              },
            );
          await expectReply(await send(request(action)), 503, "unavailable");
          assert.equal(cancelled, true);
          const value = JSON.stringify(
            action === "greet"
              ? { audio_data: Buffer.from(MP3).toString("base64") }
              : { text: "Jeanne" },
          );
          provider.respond = async () =>
            new Response(value + " ".repeat(max - value.length), {
              headers: { "Content-Type": "application/json" },
            });
          const response = await send(request(action));
          if (action === "greet") await expectAudio(response);
          else await expectName(response);
        }
        assert.deepEqual(
          db.rows().map((row) => row.state),
          ["unknown", "done", "unknown", "done"],
        );
      },
    );

    await t.test(
      "provider errors never retry, including unknown network/5xx/malformed STT replies",
      async (t) => {
        const { send, provider, calls, db } = fixture(t);
        const cases: { respond: () => Promise<Response>; state: string }[] = [
          ...[400, 401, 429].map((status) => ({
            respond: async () => new Response("provider-secret", { status }),
            state: "failed",
          })),
          ...[302, 408, 500, 502, 503, 504].map((status) => ({
            respond: async () => new Response("provider-secret", { status }),
            state: "unknown",
          })),
          {
            respond: async () => {
              throw new Error("provider-secret");
            },
            state: "unknown",
          },
          ...[null, [], {}, { text: null }, { text: 42 }].map((value) => ({
            respond: async () => Response.json(value),
            state: "unknown",
          })),
        ];
        for (const action of ["greet", "transcribe"] as const) {
          for (const [i, item] of cases.entries()) {
            provider.respond = item.respond;
            const req = request(action, undefined, {
              "cf-connecting-ip": `192.0.2.${i + 10}`,
            });
            const duplicate = req.clone();
            await expectReply(await send(req), 503, "unavailable");
            await expectReply(await send(duplicate), 409, "already_used");
            assert.equal(db.rows().at(-1)!.state, item.state);
          }
        }
        assert.equal(calls.length, cases.length * 2);
      },
    );

    for (const action of ["greet", "transcribe"] as const) {
      for (const phase of [
        "fetch",
        "before reading body",
        "streaming body",
      ] as const) {
        await t.test(
          `${action} timeout covers ${phase}, leaves unknown and never resends`,
          async (t) => {
            const { send, provider, db, calls } = fixture(t);
            t.mock.timers.enable({ apis: ["setTimeout"] });
            let started!: () => void;
            const reached = new Promise<void>((resolve) => {
              started = resolve;
            });
            let signal: AbortSignal | null | undefined;
            let cancelled = false;
            provider.respond = async (_action, init) => {
              signal = init.signal;
              if (phase !== "fetch")
                return new Response(
                  new ReadableStream<Uint8Array>(
                    {
                      pull() {
                        started();
                      },
                      cancel() {
                        cancelled = true;
                      },
                    },
                    { highWaterMark: phase === "streaming body" ? 0 : 1 },
                  ),
                  { headers: { "Content-Type": "application/json" } },
                );
              return new Promise<Response>((_resolve, reject) => {
                signal!.addEventListener(
                  "abort",
                  () => reject(new DOMException("Timed out", "AbortError")),
                  { once: true },
                );
                started();
              });
            };
            const req = request(action);
            const duplicate = req.clone();
            const pending = send(req);
            await reached;
            const duration = action === "greet" ? 20000 : 12000;
            t.mock.timers.tick(duration - 1);
            assert.equal(signal!.aborted, false);
            t.mock.timers.tick(1);
            await expectReply(await pending, 503, "unavailable");
            assert.equal(signal!.aborted, true);
            if (phase !== "fetch") assert.equal(cancelled, true);
            assert.equal(db.rows()[0].state, "unknown");
            await expectReply(await send(duplicate), 409, "already_used");
            assert.equal(calls.length, 1);
          },
        );
      }
    }

    await t.test(
      "concurrent duplicates, normalized names, UUID case and changed fingerprints",
      async (t) => {
        const { greet, transcribe, provider, calls, db } = fixture(t);
        let release!: (response: Response) => void;
        let started!: () => void;
        const reached = new Promise<void>((resolve) => {
          started = resolve;
        });
        provider.respond = () =>
          new Promise<Response>((resolve) => {
            release = resolve;
            started();
          });
        const data = payload({ name: "André" });
        const first = greet(data);
        await reached;
        for (const response of await Promise.all(
          Array.from({ length: 15 }, () => greet(data)),
        ))
          await expectReply(response, 409, "already_used");
        await expectReply(
          await greet({ ...data, name: "Other" }),
          409,
          "invalid",
        );
        await expectReply(
          await transcribe(wav(), { "x-voice-request-id": data.requestId }),
          409,
          "invalid",
        );
        assert.equal(calls.length, 1);
        assert.equal(db.rows().length, 1);
        release(
          Response.json({ audio_data: Buffer.from(MP3).toString("base64") }),
        );
        await expectAudio(await first);
        await expectReply(
          await greet({
            ...data,
            name: " Andre\u0301 ",
            requestId: data.requestId.toUpperCase(),
          }),
          409,
          "already_used",
        );
        assert.equal(calls.length, 1);
      },
    );

    await t.test(
      "five requests per IP per action, atomic under concurrency; all states count",
      async (t) => {
        const { send, provider, calls, db } = fixture(t);
        provider.respond = async () => new Response(null, { status: 400 });
        for (const action of ["greet", "transcribe"]) {
          const responses = await Promise.all(
            Array.from({ length: 20 }, () => send(request(action))),
          );
          assert.equal(responses.filter((res) => res.status === 503).length, 5);
          for (const response of responses.filter((res) => res.status !== 503))
            await expectReply(response, 429, "limited");
        }
        assert.equal(calls.length, 10);
        assert.ok(db.rows().every((row) => row.state === "failed"));
        const states = ["pending", "done", "failed", "unknown", "done"];
        for (const action of ["greet", "transcribe"]) {
          db.rows()
            .filter((row) => row.action === action)
            .forEach((row, i) => {
              db.sqlite
                .prepare("UPDATE voice_requests SET state = ? WHERE id = ?")
                .run(states[i], row.id);
            });
          await expectReply(await send(request(action)), 429, "limited");
          await expectReply(
            await send(
              request(action, undefined, { "cf-connecting-ip": "192.0.2.99" }),
            ),
            503,
            "unavailable",
          );
        }
        assert.equal(calls.length, 12);
      },
    );

    await t.test(
      "fifty global reservations per action, separately, including uncertain attempts",
      async (t) => {
        const { send, provider, calls, db } = fixture(t);
        provider.respond = async () => new Response(null, { status: 503 });
        for (const action of ["greet", "transcribe"]) {
          const responses = await Promise.all(
            Array.from({ length: 60 }, (_, i) =>
              send(
                request(action, undefined, {
                  "cf-connecting-ip": `192.0.2.${i + 1}`,
                }),
              ),
            ),
          );
          assert.equal(
            responses.filter((res) => res.status === 503).length,
            50,
          );
          assert.equal(
            responses.filter((res) => res.status === 429).length,
            10,
          );
          for (const response of responses)
            await expectReply(
              response,
              response.status,
              response.status === 503 ? "unavailable" : "limited",
            );
        }
        assert.equal(calls.length, 100);
        assert.equal(db.rows().length, 100);
        assert.ok(db.rows().every((row) => row.state === "unknown"));
      },
    );

    await t.test(
      "reservation/read failures fail closed; lost final state and stale pending never resend",
      async (t) => {
        const { greet, db, calls, clock } = fixture(t);
        db.failBatch = true;
        await expectReply(await greet(), 503, "unavailable");
        db.failBatch = false;
        db.unsuccessfulBatch = true;
        await expectReply(await greet(), 503, "unavailable");
        db.unsuccessfulBatch = false;
        assert.equal(calls.length, 0);
        db.failUpdate = true;
        const data = payload();
        await expectAudio(await greet(data));
        assert.equal(db.rows()[0].state, "pending");
        db.failRead = true;
        await expectReply(await greet(data), 503, "unavailable");
        db.failRead = false;
        clock.now += 3600 * 1000;
        await expectReply(await greet(data), 409, "already_used");
        assert.equal(calls.length, 1);
      },
    );

    await t.test(
      "HMAC-only storage includes exact audio bytes and action; no PII, provider data or logs",
      async (t) => {
        const { greet, transcribe, db, calls } = fixture(t);
        const logs: unknown[][] = [];
        for (const method of ["log", "info", "warn", "error", "debug"] as const)
          t.mock.method(console, method, (...args: unknown[]) => {
            logs.push(args);
          });
        const data = payload();
        await expectAudio(await greet(data));
        const id = randomUUID();
        const bytes = wav();
        await expectName(await transcribe(bytes, { "x-voice-request-id": id }));
        await expectReply(
          await transcribe(bytes, { "x-voice-request-id": id.toUpperCase() }),
          409,
          "already_used",
        );
        const changed = bytes.slice();
        changed[45] ^= 1;
        await expectReply(
          await transcribe(changed, { "x-voice-request-id": id }),
          409,
          "invalid",
        );
        const rows = db.rows();
        assert.deepEqual(Object.keys(rows[0]).sort(), [
          "action",
          "created_at",
          "fingerprint",
          "id",
          "ip_hash",
          "state",
        ]);
        const hmac = (value: string | Uint8Array) =>
          createHmac("sha256", HASH_KEY).update(value).digest("hex");
        assert.equal(
          rows[0].fingerprint,
          hmac(JSON.stringify(["voice-fingerprint-v1", "greet", data.name])),
        );
        assert.equal(
          rows[1].fingerprint,
          hmac(
            Buffer.concat([
              Buffer.from(
                JSON.stringify(["voice-fingerprint-v1", "transcribe"]),
              ),
              bytes,
            ]),
          ),
        );
        for (const row of rows) {
          assert.equal(
            row.ip_hash,
            hmac(JSON.stringify(["voice-ip-v1", "192.0.2.1"])),
          );
          assert.equal(row.created_at, START / 1000);
          assert.equal(row.state, "done");
        }
        for (const secret of [
          data.name,
          "192.0.2.1",
          HASH_KEY,
          "test-only-direct-voice-key",
          "Je m'appelle",
          "audio_data",
          "prenom.wav",
        ]) {
          assert.equal(JSON.stringify(rows).includes(secret), false);
          assert.equal(JSON.stringify(db.operations).includes(secret), false);
        }
        assert.equal(logs.length, 0);
        assert.equal(calls.length, 2);
      },
    );

    await t.test(
      "rolling hour and UTC day boundaries, configured lower limit, 48-hour cleanup",
      async (t) => {
        const { greet, transcribe, db, clock, env } = fixture(t);
        for (let i = 0; i < 5; i++) await expectAudio(await greet());
        clock.now += 3600 * 1000;
        await expectReply(await greet(), 429, "limited");
        clock.now += 1000;
        await expectAudio(await greet());
        db.sqlite.exec("DELETE FROM voice_requests");
        env.VOICE_DAILY_LIMIT = "1";
        clock.now = Date.parse("2026-11-06T23:59:59Z");
        await expectAudio(await greet());
        await expectReply(await greet(), 429, "limited");
        await expectName(await transcribe());
        await expectReply(await transcribe(), 429, "limited");
        clock.now += 1000;
        const data = payload();
        await expectAudio(await greet(data));
        await expectName(await transcribe());
        const row = db.rows()[0];
        for (const age of [48 * 3600, 48 * 3600 + 1])
          db.sqlite
            .prepare("INSERT INTO voice_requests VALUES (?, ?, ?, ?, ?, ?)")
            .run(
              randomUUID(),
              "greet",
              row.fingerprint,
              row.ip_hash,
              clock.now / 1000 - age,
              "failed",
            );
        await expectReply(await greet(data), 409, "already_used");
        assert.equal(db.rows().length, 5);
        assert.ok(
          db
            .rows()
            .every((item) => item.created_at >= clock.now / 1000 - 48 * 3600),
        );
      },
    );

    await t.test(
      "migration checks, indexes and actual transaction rollback",
      async (t) => {
        const { db } = fixture(t);
        const insert = "INSERT INTO voice_requests VALUES (?, ?, ?, ?, ?, ?)";
        assert.throws(
          () =>
            db.sqlite
              .prepare(insert)
              .run(
                randomUUID(),
                "chat",
                "hash",
                "hash",
                START / 1000,
                "pending",
              ),
          /CHECK constraint/u,
        );
        assert.throws(
          () =>
            db.sqlite
              .prepare(insert)
              .run(
                randomUUID(),
                "greet",
                "hash",
                "hash",
                START / 1000,
                "accepted",
              ),
          /CHECK constraint/u,
        );
        assert.throws(
          () =>
            db.sqlite
              .prepare(insert)
              .run(
                randomUUID(),
                "greet",
                null,
                "hash",
                START / 1000,
                "pending",
              ),
          /NOT NULL/u,
        );
        const id = randomUUID();
        await assert.rejects(
          db.batch([
            db
              .prepare(insert)
              .bind(id, "greet", "hash", "hash", START / 1000, "pending"),
            db
              .prepare(insert)
              .bind(id, "greet", "hash", "hash", START / 1000, "pending"),
          ]),
          /UNIQUE constraint/u,
        );
        assert.equal(db.rows().length, 0);
        assert.equal(
          db.sqlite.prepare("PRAGMA index_list(voice_requests)").all().length,
          4,
        );
      },
    );
  },
);
