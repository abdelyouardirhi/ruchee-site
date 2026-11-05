import {
  callbackEmails,
  normalizeName,
  normalizePhone,
  painById,
} from "../../chat-content.js";

export interface D1Result<T = unknown> {
  success: boolean;
  results: T[];
}

export interface D1Statement {
  bind(...values: (string | number)[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<D1Result<T>[]>;
}

export interface Env {
  RECAP_EMAIL_ENABLED?: string;
  BREVO_API_KEY?: string;
  RECAP_SENDER_EMAIL?: string;
  // Who receives the « à rappeler » e-mail. Defaults to contact@ruchee.fr.
  RECAP_TEAM_EMAIL?: string;
  RECAP_HASH_KEY?: string;
  RECAP_ALLOWED_ORIGINS?: string;
  RECAP_DAILY_LIMIT?: string;
  RECAP_DB?: D1Database;
}

type Code =
  | "sent"
  | "invalid"
  | "unavailable"
  | "limited"
  | "pending"
  | "uncertain";
type State = "pending" | "accepted" | "failed" | "unknown";
interface Submission {
  name: string;
  phone: string;
  email: string;
  topic: string;
  requestId: string;
}

const MESSAGES: Record<Code, string> = {
  sent: "C'est noté : nous vous rappelons.",
  invalid: "La demande n'est pas valide. Vérifiez les informations saisies.",
  unavailable: "L'envoi est indisponible pour le moment. Réessayez plus tard.",
  limited: "La limite d'envoi est atteinte. Réessayez demain.",
  pending: "Cette demande est déjà en cours. Réessayez avec la même demande.",
  uncertain: "L'envoi n'a pas pu être confirmé. Ne renvoyez pas cette demande.",
};

function reply(status: number, code: Code, retryable = false): Response {
  return new Response(
    JSON.stringify({
      ok: code === "sent",
      code,
      message: MESSAGES[code],
      retryable,
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...(status === 405 ? { Allow: "POST" } : {}),
        ...(status === 429 ? { "Retry-After": "86400" } : {}),
      },
    },
  );
}

function emailAddress(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254) return null;
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (
    !local ||
    !domain ||
    local.length > 64 ||
    !/^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/u.test(
      local,
    )
  )
    return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !/^[a-z]{2,63}$/u.test(labels.at(-1)!)) return null;
  if (
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
    )
  )
    return null;
  return email;
}

async function submission(request: Request): Promise<Submission | null> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  let aborted = false;
  const cancel = () => {
    aborted = true;
    // Do not await cancellation: an untrusted stream may never settle it.
    void reader.cancel().catch(() => {});
  };
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  // A fixed deadline, not an idle timeout: trickled bytes must not extend it.
  const timeout = setTimeout(cancel, 10000);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (aborted) return null;
    while (true) {
      const { value, done } = await reader.read();
      if (aborted) return null;
      if (done) break;
      size += value.byteLength;
      if (size > 2048) {
        cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const data: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const fields = data as Record<string, unknown>;
    const keys = ["name", "phone", "email", "topic", "website", "requestId"];
    if (
      Object.keys(fields).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(fields, key))
    )
      return null;
    const name = normalizeName(fields.name);
    if (!name) return null;
    const phone = normalizePhone(fields.phone);
    if (!phone) return null;
    const email = emailAddress(fields.email);
    if (!email || fields.website !== "") return null;
    const pain = painById(fields.topic);
    if (!pain) return null;
    if (
      typeof fields.requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        fields.requestId,
      )
    )
      return null;
    return {
      name,
      phone,
      email,
      topic: pain.id,
      requestId: fields.requestId.toLowerCase(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function onRequest({
  request,
  env,
}: {
  request: Request;
  env: Env;
}): Promise<Response> {
  if (request.method !== "POST") return reply(405, "invalid");
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin)
    return reply(400, "invalid");
  const data = await submission(request);
  if (!data || request.signal.aborted) return reply(400, "invalid");

  const sender = emailAddress(env.RECAP_SENDER_EMAIL);
  const team = emailAddress(env.RECAP_TEAM_EMAIL ?? "contact@ruchee.fr");
  const origins = env.RECAP_ALLOWED_ORIGINS?.split(",").map((value) =>
    value.trim(),
  );
  const limitValue = env.RECAP_DAILY_LIMIT ?? "50";
  const limit = Number(limitValue);
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  if (
    env.RECAP_EMAIL_ENABLED !== "true" ||
    !env.BREVO_API_KEY?.trim() ||
    !sender ||
    !team ||
    !env.RECAP_HASH_KEY ||
    env.RECAP_HASH_KEY.trim().length < 32 ||
    !env.RECAP_DB ||
    !ip ||
    !/^[0-9]+$/u.test(limitValue) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !origins?.length ||
    origins.some((value) => {
      try {
        const url = new URL(value);
        return (
          !["https:", "http:"].includes(url.protocol) ||
          url.origin !== value ||
          value.includes("*")
        );
      } catch {
        return true;
      }
    })
  )
    return reply(503, "unavailable", true);
  if (!origins.includes(origin)) return reply(400, "invalid");

  const db = env.RECAP_DB;
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(env.RECAP_HASH_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const hash = async (
      domain: string,
      ...values: string[]
    ): Promise<string> => {
      const digest = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(JSON.stringify([domain, ...values])),
      );
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    };
    const [fingerprint, ipHash, emailHash] = await Promise.all([
      hash("callback-v2", data.name, data.phone, data.email, data.topic),
      hash("ip", ip),
      hash("email", data.email),
    ]);
    const now = Math.floor(Date.now() / 1000);
    // D1 batch is transactional; the INSERT owns every counter check, including races.
    const results = await db.batch<{ id: string }>([
      db
        .prepare("DELETE FROM recap_requests WHERE created_at < ?")
        .bind(now - 48 * 3600),
      db
        .prepare(
          `INSERT INTO recap_requests (id, fingerprint, ip_hash, email_hash, created_at, state)
        SELECT ?, ?, ?, ?, ?, 'pending'
        WHERE (SELECT COUNT(*) FROM recap_requests WHERE ip_hash = ? AND created_at >= ?) < 5
          AND (SELECT COUNT(*) FROM recap_requests WHERE email_hash = ? AND created_at >= ? AND state <> 'failed') < 1
          AND (SELECT COUNT(*) FROM recap_requests WHERE created_at >= ?) < ?
        ON CONFLICT(id) DO NOTHING RETURNING id`,
        )
        .bind(
          data.requestId,
          fingerprint,
          ipHash,
          emailHash,
          now,
          ipHash,
          now - 3600,
          emailHash,
          now - 86400,
          Math.floor(now / 86400) * 86400,
          limit,
        ),
    ]);
    if (results.length !== 2 || results.some((result) => !result.success))
      return reply(503, "unavailable", true);
    if (results[1].results.length === 0) {
      const existing = await db
        .prepare(
          "SELECT fingerprint, state, created_at FROM recap_requests WHERE id = ?",
        )
        .bind(data.requestId)
        .first<{ fingerprint: string; state: State; created_at: number }>();
      if (!existing) return reply(429, "limited");
      if (existing.fingerprint !== fingerprint) return reply(409, "invalid");
      switch (existing.state) {
        case "accepted":
          return reply(200, "sent");
        case "pending":
          // A lost final write must not suggest retrying an already accepted email.
          return now - existing.created_at >= 120
            ? reply(503, "uncertain")
            : reply(409, "pending", true);
        case "unknown":
          return reply(503, "uncertain");
        case "failed":
          return reply(503, "unavailable", true);
        default:
          return reply(503, "unavailable", true);
      }
    }

    const emails = callbackEmails(data);
    const brevo = async (message: Record<string, unknown>): Promise<State> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "api-key": env.BREVO_API_KEY!,
          },
          body: JSON.stringify({
            sender: { name: "Léa · Ruchée", email: sender },
            ...message,
          }),
        });
        if (!response.ok)
          return response.status >= 500 || response.status === 408
            ? "unknown"
            : "failed";
        const result: unknown = await response.json();
        return result &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          "messageId" in result &&
          typeof result.messageId === "string" &&
          result.messageId.trim()
          ? "accepted"
          : "unknown";
      } catch {
        // A network error can occur after acceptance. Never automatically resend.
        return "unknown";
      } finally {
        clearTimeout(timeout);
      }
    };
    // The team e-mail is the callback request itself: its outcome is the state.
    const state = await brevo({
      replyTo: { email: data.email, name: data.name },
      to: [{ email: team }],
      subject: emails.team.subject,
      textContent: emails.team.text,
    });
    // The visitor's confirmation is a courtesy copy, sent once, never retried.
    if (state === "accepted")
      await brevo({
        replyTo: { email: team },
        to: [{ email: data.email, name: data.name }],
        subject: emails.visitor.subject,
        textContent: emails.visitor.text,
      });
    try {
      await db
        .prepare(
          "UPDATE recap_requests SET state = ? WHERE id = ? AND state = 'pending'",
        )
        .bind(state, data.requestId)
        .run();
    } catch {
      // Keep the pending reservation if storage fails, even after provider acceptance.
    }
    if (state === "accepted") return reply(200, "sent");
    return state === "failed"
      ? reply(503, "unavailable", true)
      : reply(503, "uncertain");
  } catch {
    return reply(503, "unavailable", true);
  }
}
