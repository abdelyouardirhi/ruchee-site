import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { callbackEmails } from "../chat-content.js";
import {
  onRequest,
  type D1Database,
  type D1Result,
  type D1Statement,
  type Env,
} from "../functions/api/recap.js";

const migration = readFileSync(
  new URL("../migrations/0001_recap.sql", import.meta.url),
  "utf8",
);
const ORIGIN = "https://ruchee.example";
const HASH_KEY = "test-only-hmac-key-with-at-least-32-characters";
const START = Date.parse("2026-11-05T12:00:00Z");

interface Row {
  id: string;
  fingerprint: string;
  ip_hash: string;
  email_hash: string;
  created_at: number;
  state: string;
}

// Everything inside batch executes synchronously in one SQLite transaction, just
// like D1's serialized transactional batch. Never await while holding BEGIN.
class SQLiteD1 implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  readonly operations: { sql: string; values: (string | number)[] }[] = [];
  failBatch = false;
  failUpdate = false;
  constructor() {
    this.sqlite.exec(migration);
  }
  prepare(sql: string): D1Statement {
    // Associate bound statements with their SQL without making batch asynchronous.
    const tracked = (values: (string | number)[]): D1Statement => {
      const bound: D1Statement = {
        bind: (...next) => tracked(next),
        first: async <T>() => this.execute<T>(sql, values).results[0] ?? null,
        all: async <T>() => this.execute<T>(sql, values),
        run: async () => this.execute(sql, values),
      };
      this.statements.set(bound, { sql, values });
      return bound;
    };
    return tracked([]);
  }
  private readonly statements = new WeakMap<
    D1Statement,
    { sql: string; values: (string | number)[] }
  >();
  private execute<T>(sql: string, values: (string | number)[]): D1Result<T> {
    this.operations.push({ sql, values });
    if (this.failUpdate && sql.startsWith("UPDATE"))
      throw new Error("Storage unavailable");
    return {
      success: true,
      results: this.sqlite.prepare(sql).all(...values) as T[],
    };
  }
  async batch<T>(statements: D1Statement[]): Promise<D1Result<T>[]> {
    if (this.failBatch) throw new Error("Storage unavailable");
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
      .prepare("SELECT * FROM recap_requests")
      .all() as unknown as Row[];
  }
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    name: "Jeanne Martin",
    phone: "06 12 34 56 78",
    email: "jeanne@example.test",
    website: "",
    requestId: randomUUID(),
    ...overrides,
  };
}

function request(
  data: unknown = payload(),
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}/api/recap`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "cf-connecting-ip": "192.0.2.1",
      ...headers,
    },
    body: JSON.stringify(data),
  });
}

interface Email {
  sender: { name: string; email: string };
  replyTo: { email: string; name?: string };
  to: { email: string; name?: string }[];
  subject: string;
  textContent: string;
}

function fixture(t: TestContext) {
  const db = new SQLiteD1();
  const clock = { now: START };
  t.mock.method(Date, "now", () => clock.now);
  const env: Env = {
    RECAP_EMAIL_ENABLED: "true",
    BREVO_API_KEY: "test-only-not-a-real-api-key",
    RECAP_SENDER_EMAIL: "sender@example.test",
    RECAP_HASH_KEY: HASH_KEY,
    RECAP_ALLOWED_ORIGINS: `${ORIGIN}, https://other.example`,
    RECAP_DB: db,
  };
  // calls: the « à rappeler » e-mails to the team (one per accepted request).
  // copies: the visitor confirmations, sent only after the team e-mail.
  const calls: Email[] = [];
  const copies: Email[] = [];
  const provider = {
    respond: async (_init: RequestInit): Promise<Response> =>
      Response.json({ messageId: "test-message-id" }, { status: 201 }),
    copy: async (_init: RequestInit): Promise<Response> =>
      Response.json({ messageId: "test-copy-id" }, { status: 201 }),
  };
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(url, "https://api.brevo.com/v3/smtp/email");
      assert.ok(init);
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).get("api-key"), env.BREVO_API_KEY);
      assert.equal(
        new Headers(init.headers).get("content-type"),
        "application/json",
      );
      assert.ok(init.signal instanceof AbortSignal);
      const email = JSON.parse(String(init.body)) as Email;
      const toTeam = email.to[0].email === "contact@ruchee.fr";
      const visitor = toTeam ? email.replyTo.email : email.to[0].email;
      // No unsigned/unreserved outbound call, even under concurrent requests.
      const recipientHash = createHmac("sha256", HASH_KEY)
        .update(JSON.stringify(["email", visitor]))
        .digest("hex");
      assert.equal(
        db
          .rows()
          .filter(
            (row) =>
              row.email_hash === recipientHash && row.state === "pending",
          ).length,
        1,
      );
      if (!toTeam) {
        copies.push(email);
        return provider.copy(init);
      }
      calls.push(email);
      return provider.respond(init);
    },
  );
  t.after(() => {
    t.mock.restoreAll();
    db.sqlite.close();
  });
  const send = (
    data: unknown = payload(),
    headers: Record<string, string> = {},
  ) => onRequest({ request: request(data, headers), env });
  return { db, env, calls, copies, provider, send, clock };
}

async function expectReply(
  response: Response,
  status: number,
  code: string,
  retryable = false,
) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json/u,
  );
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  if (status === 429)
    assert.equal(response.headers.get("retry-after"), "86400");
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    "code",
    "message",
    "ok",
    "retryable",
  ]);
  assert.equal(body.ok, code === "sent");
  assert.equal(body.code, code);
  assert.equal(body.retryable, retryable);
  assert.equal(typeof body.message, "string");
  assert.ok(String(body.message).length > 10);
  assert.doesNotMatch(
    String(body.message),
    /test-only|provider-secret|@example|192\.0\.2/u,
  );
  return body;
}

test(
  "recap backend (serial fetch mocks, real SQLite SQL)",
  { concurrency: false },
  async (t) => {
    await t.test(
      "missing or invalid configuration fails closed before SQL or fetch",
      async (t) => {
        const { env, db, calls } = fixture(t);
        const bad: Partial<Env>[] = [
          ...[
            "RECAP_EMAIL_ENABLED",
            "BREVO_API_KEY",
            "RECAP_SENDER_EMAIL",
            "RECAP_HASH_KEY",
            "RECAP_ALLOWED_ORIGINS",
            "RECAP_DB",
          ].map((key) => ({ [key]: undefined })),
          { RECAP_EMAIL_ENABLED: "false" },
          { RECAP_EMAIL_ENABLED: "TRUE" },
          { BREVO_API_KEY: " " },
          { RECAP_SENDER_EMAIL: "not an address" },
          { RECAP_SENDER_EMAIL: "sender@example.test\r\nBcc:x@y.test" },
          { RECAP_HASH_KEY: "x".repeat(31) },
          { RECAP_HASH_KEY: " ".repeat(32) },
          ...[
            "*",
            `${ORIGIN},*`,
            `${ORIGIN},`,
            `${ORIGIN}/`,
            "null",
            "https://*.example",
            "https://user:pass@ruchee.example",
          ].map((value) => ({ RECAP_ALLOWED_ORIGINS: value })),
          ...["0", "51", "-1", "1.5", "no", "", "Infinity", " 2"].map(
            (value) => ({ RECAP_DAILY_LIMIT: value }),
          ),
        ];
        for (const override of bad)
          await expectReply(
            await onRequest({
              request: request(),
              env: { ...env, ...override },
            }),
            503,
            "unavailable",
            true,
          );
        const noIp = request(undefined, {
          "x-forwarded-for": "192.0.2.1",
          "x-real-ip": "192.0.2.1",
        });
        noIp.headers.delete("cf-connecting-ip");
        await expectReply(
          await onRequest({ request: noIp, env }),
          503,
          "unavailable",
          true,
        );
        assert.equal(db.operations.length, 0);
        assert.equal(calls.length, 0);
      },
    );

    await t.test(
      "method and both origin checks reject without SQL",
      async (t) => {
        const { env, send, db, calls } = fixture(t);
        for (const method of ["GET", "PUT", "OPTIONS", "DELETE"]) {
          const response = await onRequest({
            request: new Request(`${ORIGIN}/api/recap`, { method }),
            env,
          });
          assert.equal(response.headers.get("allow"), "POST");
          await expectReply(response, 405, "invalid");
        }
        for (const origin of [
          "",
          "null",
          "https://attacker.example",
          "https://other.example",
          `${ORIGIN}/`,
        ]) {
          await expectReply(await send(payload(), { origin }), 400, "invalid");
        }
        env.RECAP_ALLOWED_ORIGINS = "https://other.example";
        await expectReply(await send(), 400, "invalid");
        assert.equal(db.operations.length, 0);
        assert.equal(calls.length, 0);
      },
    );

    await t.test(
      "strict object, names, emails, allowlist, honeypot and UUID validation",
      async (t) => {
        const { send, db, calls } = fixture(t);
        const invalid: unknown[] = [
          null,
          [],
          "text",
          42,
          {},
          { ...payload(), extra: "anything" },
        ];
        for (const name of [
          "",
          " ",
          "-",
          "Jean3",
          "a".repeat(61),
          "https://evil.test",
          "<Jean>",
          "Jean\n",
          "Jean\tMartin",
          "Jean\u0000",
          "Jean\u200b",
          "Jean\u202e",
        ])
          invalid.push(payload({ name }));
        for (const email of [
          "",
          "no-at",
          "a@@b.test",
          "a b@example.test",
          "<a@example.test>",
          "a@example.test\r\n",
          "a@example.test\u0000",
          ".a@example.test",
          "a..b@example.test",
          "a.@example.test",
          "a@-bad.test",
          "a@bad-.test",
          "a@bad..test",
          "a@localhost",
          "a@b.1",
          `${"a".repeat(65)}@b.test`,
          `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.test`,
        ])
          invalid.push(payload({ email }));
        for (const scenario of [
          "absence",
          "recrutement",
          "suivi",
          "other",
          "ABSENCE",
          "__proto__",
          "constructor",
          null,
          1,
        ])
          invalid.push(payload({ scenario }));
        for (const website of ["https://spam.test", " ", null, false])
          invalid.push(payload({ website }));
        for (const requestId of [
          "bad",
          "00000000-0000-0000-0000-000000000000",
          "12345678-1234-1234-8123-123456789abc",
          "12345678-1234-4234-7123-123456789abc",
          null,
        ])
          invalid.push(payload({ requestId }));
        for (const phone of ["123", "06 12 34", "+33 0 12", "abc", 612345678, null])
          invalid.push(payload({ phone }));
        for (const field of ["name", "phone", "email", "website", "requestId"]) {
          const data: Record<string, unknown> = payload();
          delete data[field];
          invalid.push(data);
        }
        for (const value of invalid)
          await expectReply(await send(value), 400, "invalid");
        assert.equal(db.operations.length, 0);
        assert.equal(calls.length, 0);
      },
    );

    await t.test(
      "JSON type, malformed body and actual streamed byte limit, ignoring Content-Length",
      async (t) => {
        const { env, db, calls } = fixture(t);
        for (const type of [
          "text/plain",
          "application/x-www-form-urlencoded",
          "",
        ]) {
          await expectReply(
            await onRequest({
              request: request(payload(), { "content-type": type }),
              env,
            }),
            400,
            "invalid",
          );
        }
        for (const body of [
          "{",
          "",
          `${JSON.stringify(payload())}${" ".repeat(2048)}`,
        ]) {
          await expectReply(
            await onRequest({
              request: new Request(`${ORIGIN}/api/recap`, {
                method: "POST",
                headers: {
                  origin: ORIGIN,
                  "content-type": "application/json",
                  "content-length": "1",
                  "cf-connecting-ip": "192.0.2.1",
                },
                body,
              }),
              env,
            }),
            400,
            "invalid",
          );
        }
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(" ".repeat(1024)));
            controller.enqueue(new TextEncoder().encode("é".repeat(513)));
          },
          cancel() {
            cancelled = true;
          },
        });
        const init: RequestInit & { duplex: "half" } = {
          method: "POST",
          duplex: "half",
          body,
          headers: {
            origin: ORIGIN,
            "content-type": "application/json",
            "content-length": "2",
            "cf-connecting-ip": "192.0.2.1",
          },
        };
        await expectReply(
          await onRequest({
            request: new Request(`${ORIGIN}/api/recap`, init),
            env,
          }),
          400,
          "invalid",
        );
        assert.equal(cancelled, true);
        assert.equal(db.operations.length, 0);
        assert.equal(calls.length, 0);
        const json = JSON.stringify(payload());
        const exact = request();
        await expectReply(
          await onRequest({
            request: new Request(exact.url, {
              method: "POST",
              headers: exact.headers,
              body: json + " ".repeat(2048 - Buffer.byteLength(json)),
            }),
            env,
          }),
          200,
          "sent",
        );
        assert.equal(calls.length, 1);
      },
    );

    for (const stop of [
      "deadline",
      "client abort",
      "already aborted",
    ] as const) {
      await t.test(`upload ${stop} cancels before SQL or fetch`, async (t) => {
        const { env, db, calls } = fixture(t);
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const scheduled = t.mock.method(globalThis, "setTimeout");
        const cleared = t.mock.method(globalThis, "clearTimeout");
        const fetch = t.mock.method(globalThis, "fetch");
        const prepare = t.mock.method(db, "prepare");
        const batch = t.mock.method(db, "batch");
        const logs: unknown[][] = [];
        for (const method of ["log", "info", "warn", "error", "debug"] as const)
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
                new TextEncoder().encode('{"name":"Jeanne Martin"'),
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
        const init: RequestInit & { duplex: "half" } = {
          method: "POST",
          duplex: "half",
          body: stream,
          headers: request().headers,
          signal: client.signal,
        };
        const req = new Request(`${ORIGIN}/api/recap`, init);
        if (stop === "already aborted")
          client.abort(new Error("jeanne@example.test"));
        let settled = false;
        const pending = onRequest({ request: req, env }).then((response) => {
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
          else client.abort(new Error("jeanne@example.test"));
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
      });
    }

    await t.test(
      "upload cleanup on success, malformed, oversized and broken bodies",
      async (t) => {
        const { env } = fixture(t);
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const scheduled = t.mock.method(globalThis, "setTimeout");
        const cleared = t.mock.method(globalThis, "clearTimeout");
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
                controller.enqueue(new Uint8Array(2049));
              else {
                controller.enqueue(
                  outcome === "malformed"
                    ? Uint8Array.of(0xff)
                    : new TextEncoder().encode(JSON.stringify(payload())),
                );
                controller.close();
              }
            },
            cancel() {
              cancelled++;
              return Promise.reject(new Error("cancel failed"));
            },
          });
          const init: RequestInit & { duplex: "half" } = {
            method: "POST",
            duplex: "half",
            body: stream,
            headers: request().headers,
            signal: client.signal,
          };
          const req = new Request(`${ORIGIN}/api/recap`, init);
          await expectReply(
            await onRequest({ request: req, env }),
            outcome === "success" ? 200 : 400,
            outcome === "success" ? "sent" : "invalid",
          );
          assert.equal(stream.locked, false);
          assert.deepEqual(getEventListeners(req.signal, "abort"), []);
          client.abort();
          t.mock.timers.tick(30000);
          assert.equal(cancelled, outcome === "oversized" ? 1 : 0);
        }
        assert.deepEqual(
          cleared.mock.calls.map((call) => call.arguments[0]),
          scheduled.mock.calls.map((call) => call.result),
        );
      },
    );

    await t.test(
      "team e-mail first (reply-to visitor), then one visitor copy, fixed headers, plain text",
      async (t) => {
        const { send, calls, copies, db } = fixture(t);
        for (const suffix of ["one", "two", "three"]) {
          const data = payload({
            name: "  Éloïse D’Arcy-Andre\u0301  ",
            phone: " +33 6 12.34-56 78 ",
            email: `  ELOISE+${suffix}@EXAMPLE.TEST  `,
          });
          const before = structuredClone(data);
          await expectReply(await send(data), 200, "sent");
          assert.deepEqual(data, before);
          const expected = callbackEmails({
            name: "Éloïse D’Arcy-André",
            phone: "+33612345678",
            email: `eloise+${suffix}@example.test`,
          });
          const team = calls.at(-1)!;
          assert.deepEqual(Object.keys(team).sort(), [
            "replyTo",
            "sender",
            "subject",
            "textContent",
            "to",
          ]);
          assert.deepEqual(team.sender, {
            name: "Léa · Ruchée",
            email: "sender@example.test",
          });
          assert.deepEqual(team.to, [{ email: "contact@ruchee.fr" }]);
          assert.deepEqual(team.replyTo, {
            email: `eloise+${suffix}@example.test`,
            name: "Éloïse D’Arcy-André",
          });
          assert.equal(team.subject, expected.team.subject);
          assert.equal(team.textContent, expected.team.text);
          assert.match(team.textContent, /06 12 34 56 78/u);
          const copy = copies.at(-1)!;
          assert.deepEqual(copy.to, [
            {
              email: `eloise+${suffix}@example.test`,
              name: "Éloïse D’Arcy-André",
            },
          ]);
          assert.deepEqual(copy.replyTo, { email: "contact@ruchee.fr" });
          assert.equal(copy.subject, expected.visitor.subject);
          assert.equal(copy.textContent, expected.visitor.text);
          assert.ok(copy.textContent.startsWith("Bonjour Éloïse D’Arcy-André,"));
          assert.match(copy.textContent, /assistante virtuelle/u);
          assert.match(copy.textContent, /une seule fois, à votre demande/u);
          assert.match(copy.textContent, /aucune newsletter/u);
        }
        for (const field of [
          "to",
          "bcc",
          "cc",
          "headers",
          "subject",
          "textContent",
          "htmlContent",
          "sender",
          "replyTo",
          "attachments",
          "steps",
        ]) {
          await expectReply(
            await send(payload({ [field]: "attacker-controlled" })),
            400,
            "invalid",
          );
        }
        assert.equal(calls.length, 3);
        assert.equal(copies.length, 3);
        assert.equal(db.rows().length, 3);
      },
    );

    await t.test(
      "RECAP_TEAM_EMAIL changes the team recipient; an invalid one disables sending",
      async (t) => {
        const { send, env, calls, copies } = fixture(t);
        env.RECAP_TEAM_EMAIL = "not an address";
        await expectReply(await send(), 503, "unavailable", true);
        assert.equal(calls.length + copies.length, 0);
      },
    );

    await t.test(
      "a failed visitor copy never changes the outcome nor triggers a resend",
      async (t) => {
        const { send, provider, calls, copies, db } = fixture(t);
        provider.copy = async () =>
          Response.json({ message: "down" }, { status: 500 });
        const data = payload();
        await expectReply(await send(data), 200, "sent");
        await expectReply(await send(data), 200, "sent");
        assert.equal(calls.length, 1);
        assert.equal(copies.length, 1);
        assert.equal(db.rows()[0].state, "accepted");
      },
    );

    await t.test(
      "no visitor copy when the team e-mail is not accepted",
      async (t) => {
        const { send, provider, copies } = fixture(t);
        provider.respond = async () =>
          Response.json({ message: "bad" }, { status: 400 });
        await expectReply(await send(), 503, "unavailable", true);
        assert.equal(copies.length, 0);
      },
    );

    await t.test(
      "accepted dedupe and fingerprint conflicts never resend, UUID case canonicalized",
      async (t) => {
        const { send, calls } = fixture(t);
        const data = payload();
        await expectReply(await send(data), 200, "sent");
        await expectReply(await send(data), 200, "sent");
        await expectReply(
          await send({
            ...data,
            requestId: data.requestId.toUpperCase(),
            name: " Jeanne Martin ",
            email: " JEANNE@EXAMPLE.TEST ",
          }),
          200,
          "sent",
        );
        for (const change of [
          { name: "Other Name" },
          { phone: "07 98 76 54 32" },
          { email: "other@example.test" },
        ]) {
          await expectReply(await send({ ...data, ...change }), 409, "invalid");
        }
        assert.equal(calls.length, 1);
      },
    );

    await t.test(
      "concurrent duplicates reserve once and return pending until acceptance",
      async (t) => {
        const { send, provider, calls, db } = fixture(t);
        let release!: (response: Response) => void;
        let started!: () => void;
        const reached = new Promise<void>((resolve) => {
          started = resolve;
        });
        provider.respond = () => {
          started();
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        };
        const data = payload();
        const first = send(data);
        await reached;
        const duplicates = await Promise.all(
          Array.from({ length: 12 }, () => send(data)),
        );
        for (const response of duplicates)
          await expectReply(response, 409, "pending", true);
        await expectReply(
          await send({ ...data, name: "Other" }),
          409,
          "invalid",
        );
        await expectReply(
          await send(payload(), { "cf-connecting-ip": "192.0.2.99" }),
          429,
          "limited",
        );
        assert.equal(calls.length, 1);
        assert.equal(db.rows().length, 1);
        release(Response.json({ messageId: "accepted" }));
        await expectReply(await first, 200, "sent");
        await expectReply(await send(data), 200, "sent");
        assert.equal(calls.length, 1);
      },
    );

    await t.test(
      "distinct concurrent requests cannot exceed five attempts per IP",
      async (t) => {
        const { send, calls, db } = fixture(t);
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            send(payload({ email: `person${i}@example.test` })),
          ),
        );
        assert.equal(
          results.filter((response) => response.status === 200).length,
          5,
        );
        for (const response of results.filter(
          (response) => response.status !== 200,
        ))
          await expectReply(response, 429, "limited");
        assert.equal(calls.length, 5);
        assert.equal(db.rows().length, 5);
      },
    );

    await t.test(
      "recipient quota is normalized, cross-IP and atomic",
      async (t) => {
        const { send, calls, db } = fixture(t);
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            send(
              payload({
                email: i % 2 ? " JEANNE@EXAMPLE.TEST " : "jeanne@example.test",
              }),
              { "cf-connecting-ip": `192.0.2.${i + 1}` },
            ),
          ),
        );
        assert.equal(
          results.filter((response) => response.status === 200).length,
          1,
        );
        assert.equal(
          results.filter((response) => response.status === 429).length,
          11,
        );
        assert.equal(calls.length, 1);
        assert.equal(db.rows().length, 1);
      },
    );

    await t.test(
      "global ceiling is fifty atomic attempts, including definitively failed attempts",
      async (t) => {
        const { send, calls, db, provider } = fixture(t);
        provider.respond = async () =>
          new Response("provider-secret-details", { status: 400 });
        const results = await Promise.all(
          Array.from({ length: 60 }, (_, i) =>
            send(payload({ email: `person${i}@example.test` }), {
              "cf-connecting-ip": `192.0.2.${i + 1}`,
            }),
          ),
        );
        assert.equal(
          results.filter((response) => response.status === 503).length,
          50,
        );
        assert.equal(
          results.filter((response) => response.status === 429).length,
          10,
        );
        for (const response of results)
          await expectReply(
            response,
            response.status,
            response.status === 503 ? "unavailable" : "limited",
            response.status === 503,
          );
        assert.equal(calls.length, 50);
        assert.equal(db.rows().length, 50);
        assert.ok(db.rows().every((row) => row.state === "failed"));
      },
    );

    await t.test(
      "definite provider rejection allows a NEW UUID, never retries the same ID",
      async (t) => {
        const { send, provider, calls, db } = fixture(t);
        for (const status of [400, 401, 429]) {
          provider.respond = async () =>
            new Response("provider-secret-details", { status });
          const data = payload();
          await expectReply(await send(data), 503, "unavailable", true);
          await expectReply(await send(data), 503, "unavailable", true);
        }
        assert.equal(calls.length, 3);
        provider.respond = async () => Response.json({ messageId: "accepted" });
        await expectReply(await send(), 200, "sent");
        assert.equal(calls.length, 4);
        assert.deepEqual(
          db.rows().map((row) => row.state),
          ["failed", "failed", "failed", "accepted"],
        );
      },
    );

    await t.test(
      "failed attempts still exhaust IP quota, but leave recipient quota free",
      async (t) => {
        const { send, provider, calls } = fixture(t);
        provider.respond = async () => new Response(null, { status: 429 });
        for (let i = 0; i < 5; i++)
          await expectReply(await send(), 503, "unavailable", true);
        await expectReply(await send(), 429, "limited");
        await expectReply(
          await send(payload(), { "cf-connecting-ip": "192.0.2.2" }),
          503,
          "unavailable",
          true,
        );
        assert.equal(calls.length, 6);
      },
    );

    await t.test(
      "network errors and invalid 2xx replies are unknown and never resent",
      async (t) => {
        const { send, provider, db, calls } = fixture(t);
        const replies: (() => Promise<Response>)[] = [
          ...[408, 500, 502, 503, 504].map(
            (status) => async () => new Response(null, { status }),
          ),
          async () => {
            throw new Error("provider-secret-details");
          },
          async () => new Response("invalid JSON", { status: 200 }),
          ...[
            {},
            { messageId: "" },
            { messageId: " " },
            { messageId: 42 },
            null,
            [],
          ].map((body) => async () => Response.json(body)),
          async () => new Response(null, { status: 204 }),
        ];
        for (const [i, respond] of replies.entries()) {
          provider.respond = respond;
          const data = payload({ email: `person${i}@example.test` });
          const headers = { "cf-connecting-ip": `192.0.2.${i + 1}` };
          await expectReply(await send(data, headers), 503, "uncertain");
          await expectReply(await send(data, headers), 503, "uncertain");
          await expectReply(
            await send({ ...data, requestId: randomUUID() }, headers),
            429,
            "limited",
          );
        }
        assert.equal(calls.length, replies.length);
        assert.ok(db.rows().every((row) => row.state === "unknown"));
      },
    );

    await t.test(
      "eight-second abort timeout becomes unknown without any resend",
      async (t) => {
        const { send, provider, db, calls } = fixture(t);
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let started!: () => void;
        const reached = new Promise<void>((resolve) => {
          started = resolve;
        });
        let signal: AbortSignal | null | undefined;
        provider.respond = (init) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init.signal;
            signal!.addEventListener(
              "abort",
              () => reject(new DOMException("Timed out", "AbortError")),
              { once: true },
            );
            started();
          });
        const data = payload();
        const pending = send(data);
        await reached;
        t.mock.timers.tick(7999);
        assert.equal(signal!.aborted, false);
        t.mock.timers.tick(1);
        await expectReply(await pending, 503, "uncertain");
        assert.equal(signal!.aborted, true);
        assert.equal(db.rows()[0].state, "unknown");
        await expectReply(await send(data), 503, "uncertain");
        assert.equal(calls.length, 1);
      },
    );

    await t.test(
      "unavailable database blocks outbound; accepted update failure still reports success",
      async (t) => {
        const { send, db, calls, clock } = fixture(t);
        db.failBatch = true;
        await expectReply(await send(), 503, "unavailable", true);
        assert.equal(calls.length, 0);
        db.failBatch = false;
        db.failUpdate = true;
        const data = payload();
        await expectReply(await send(data), 200, "sent");
        assert.equal(db.rows()[0].state, "pending");
        await expectReply(await send(data), 409, "pending", true);
        clock.now += 120000;
        await expectReply(await send(data), 503, "uncertain");
        assert.equal(calls.length, 1);
      },
    );

    await t.test(
      "SQL stores only domain-separated HMACs, UUID, timestamp and state; logs stay empty",
      async (t) => {
        const { send, db } = fixture(t);
        const logs: unknown[][] = [];
        for (const method of ["log", "info", "warn", "error", "debug"] as const)
          t.mock.method(console, method, (...args: unknown[]) => {
            logs.push(args);
          });
        const data = payload();
        await expectReply(await send(data), 200, "sent");
        const row = db.rows()[0];
        assert.deepEqual(Object.keys(row).sort(), [
          "created_at",
          "email_hash",
          "fingerprint",
          "id",
          "ip_hash",
          "state",
        ]);
        const hmac = (...values: string[]) =>
          createHmac("sha256", HASH_KEY)
            .update(JSON.stringify(values))
            .digest("hex");
        assert.equal(
          row.fingerprint,
          hmac("callback-v1", data.name, "+33612345678", data.email),
        );
        assert.equal(row.email_hash, hmac("email", data.email));
        assert.equal(row.ip_hash, hmac("ip", "192.0.2.1"));
        assert.equal(row.id, data.requestId);
        assert.equal(row.created_at, START / 1000);
        assert.equal(row.state, "accepted");
        for (const secret of [
          data.name,
          data.email,
          "192.0.2.1",
          HASH_KEY,
          "test-only-not-a-real-api-key",
        ]) {
          assert.equal(JSON.stringify(db.rows()).includes(secret), false);
          assert.equal(JSON.stringify(db.operations).includes(secret), false);
        }
        assert.equal(logs.length, 0);
      },
    );

    await t.test(
      "rolling windows expire, daily quota resets at UTC midnight",
      async (t) => {
        const { send, clock, env, db, calls } = fixture(t);
        for (let i = 0; i < 5; i++)
          await expectReply(
            await send(payload({ email: `person${i}@example.test` })),
            200,
            "sent",
          );
        clock.now += 3601 * 1000;
        await expectReply(
          await send(payload({ email: "new@example.test" })),
          200,
          "sent",
        );
        await expectReply(
          await send(payload({ email: "person0@example.test" })),
          429,
          "limited",
        );
        clock.now = START + 86401 * 1000;
        await expectReply(
          await send(payload({ email: "person0@example.test" })),
          200,
          "sent",
        );
        db.sqlite.exec("DELETE FROM recap_requests");
        env.RECAP_DAILY_LIMIT = "1";
        clock.now = Date.parse("2026-11-06T23:59:59Z");
        await expectReply(
          await send(payload({ email: "late@example.test" })),
          200,
          "sent",
        );
        await expectReply(
          await send(payload({ email: "later@example.test" })),
          429,
          "limited",
        );
        clock.now += 1000;
        await expectReply(
          await send(payload({ email: "later@example.test" })),
          200,
          "sent",
        );
        assert.equal(calls.length, 9);
      },
    );

    await t.test(
      "cleanup deletes strictly older than 48 hours even on a duplicate submission",
      async (t) => {
        const { send, db } = fixture(t);
        const data = payload();
        await expectReply(await send(data), 200, "sent");
        const row = db.rows()[0];
        for (const [id, age] of [
          [randomUUID(), 48 * 3600 + 1],
          [randomUUID(), 48 * 3600],
        ] as const) {
          db.sqlite
            .prepare("INSERT INTO recap_requests VALUES (?, ?, ?, ?, ?, ?)")
            .run(
              id,
              row.fingerprint,
              row.ip_hash,
              row.email_hash,
              START / 1000 - age,
              "failed",
            );
        }
        await expectReply(await send(data), 200, "sent");
        assert.equal(db.rows().length, 2);
        assert.ok(
          db.rows().every((row) => row.created_at >= START / 1000 - 48 * 3600),
        );
      },
    );

    await t.test(
      "migration constraints and batch rollback are enforced by actual SQLite",
      async (t) => {
        const { db } = fixture(t);
        const insert = "INSERT INTO recap_requests VALUES (?, ?, ?, ?, ?, ?)";
        assert.throws(
          () =>
            db.sqlite
              .prepare(insert)
              .run(
                randomUUID(),
                "hash",
                "hash",
                "hash",
                START / 1000,
                "invented",
              ),
          /CHECK constraint/u,
        );
        assert.throws(
          () =>
            db.sqlite
              .prepare(insert)
              .run(randomUUID(), null, "hash", "hash", START / 1000, "pending"),
          /NOT NULL/u,
        );
        const id = randomUUID();
        await assert.rejects(
          db.batch([
            db
              .prepare(insert)
              .bind(id, "hash", "hash", "hash", START / 1000, "pending"),
            db
              .prepare(insert)
              .bind(id, "hash", "hash", "hash", START / 1000, "pending"),
          ]),
          /UNIQUE constraint/u,
        );
        assert.equal(db.rows().length, 0);
        const indexes = db.sqlite
          .prepare("PRAGMA index_list(recap_requests)")
          .all();
        assert.equal(indexes.length, 4);
      },
    );
  },
);
