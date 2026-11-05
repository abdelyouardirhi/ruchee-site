import {
  normalizeName,
  personalizedReply,
  TTS_MODEL,
  TRANSCRIBE_MODEL,
  VOICE_ID,
  VOICE_EXPRESSIVENESS,
} from "../../chat-content.js";
import type { Env } from "./recap.js";

type Code =
  | "invalid"
  | "unavailable"
  | "limited"
  | "already_used"
  | "unrecognized";
const MESSAGES: Record<Code, string> = {
  invalid: "La demande n'est pas valide. Vérifiez les informations saisies.",
  unavailable:
    "La voix est indisponible pour le moment. Vous pouvez continuer par écrit.",
  limited:
    "La limite des échanges vocaux est atteinte. Vous pouvez continuer par écrit.",
  already_used:
    "Cette demande a déjà été utilisée. Vous pouvez continuer par écrit.",
  unrecognized:
    "Je n'ai pas compris votre prénom. Vous pouvez le saisir par écrit.",
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function reply(status: number, code: Code): Response {
  return Response.json(
    { ok: false, code, message: MESSAGES[code] },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(status === 405 ? { Allow: "POST" } : {}),
      },
    },
  );
}

// Bound actual streamed bytes, not the caller's Content-Length. Aborting also
// cancels a stalled body, for both uploads and provider responses.
async function readBounded(
  source: Request | Response,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!source.body) return null;
  if (signal?.aborted) {
    void source.body.cancel().catch(() => {});
    return null;
  }
  const reader = source.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) return null;
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
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
    return bytes;
  } catch {
    return null;
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function json(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
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
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  if (
    (action !== "greet" && action !== "transcribe") ||
    url.searchParams.getAll("action").length !== 1
  )
    return reply(400, "invalid");
  const origin = request.headers.get("origin");
  if (!origin || origin !== url.origin) return reply(400, "invalid");
  const origins = env.RECAP_ALLOWED_ORIGINS?.split(",").map((value) =>
    value.trim(),
  );
  const limitValue = env.VOICE_DAILY_LIMIT ?? "50";
  const limit = Number(limitValue);
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  if (
    env.VOICE_ENABLED !== "true" ||
    !env.MISTRAL_VOICE_API_KEY?.trim() ||
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
        const allowed = new URL(value);
        return (
          !["https:", "http:"].includes(allowed.protocol) ||
          allowed.origin !== value ||
          value.includes("*")
        );
      } catch {
        return true;
      }
    })
  )
    return reply(503, "unavailable");
  if (!origins.includes(origin)) return reply(400, "invalid");

  const contentType = request.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== (action === "greet" ? "application/json" : "audio/wav"))
    return reply(400, "invalid");
  const upload = new AbortController();
  const abortUpload = () => upload.abort();
  request.signal.addEventListener("abort", abortUpload, { once: true });
  if (request.signal.aborted) abortUpload();
  // A fixed deadline, not an idle timeout: trickled bytes must not extend it.
  const uploadTimeout = setTimeout(abortUpload, 10000);
  let bytes: Uint8Array<ArrayBuffer> | null;
  try {
    bytes = await readBounded(
      request,
      action === "greet" ? 1024 : 192044,
      upload.signal,
    );
  } finally {
    clearTimeout(uploadTimeout);
    request.signal.removeEventListener("abort", abortUpload);
  }
  if (!bytes || upload.signal.aborted) return reply(400, "invalid");
  let requestId: string;
  let text = "";
  const encoder = new TextEncoder();
  let fingerprintBytes: Uint8Array<ArrayBuffer>;
  if (action === "greet") {
    const data = json(bytes);
    const keys = ["name", "requestId", "website"];
    if (
      !data ||
      Object.keys(data).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(data, key)) ||
      data.website !== "" ||
      typeof data.requestId !== "string" ||
      !UUID.test(data.requestId)
    )
      return reply(400, "invalid");
    const name = normalizeName(data.name);
    if (!name) return reply(400, "invalid");
    text = personalizedReply(name);
    if ([...text].length > 240) return reply(400, "invalid");
    requestId = data.requestId.toLowerCase();
    fingerprintBytes = encoder.encode(
      JSON.stringify(["voice-fingerprint-v1", action, name]),
    );
  } else {
    const id = request.headers.get("x-voice-request-id");
    if (
      !id ||
      !UUID.test(id) ||
      (request.headers.get("x-voice-website") ?? "") !== ""
    )
      return reply(400, "invalid");
    requestId = id.toLowerCase();
    if (bytes.length < 44) return reply(400, "invalid");
    const view = new DataView(bytes.buffer);
    const tag = (offset: number) =>
      String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const length = view.getUint32(40, true);
    if (
      tag(0) !== "RIFF" ||
      view.getUint32(4, true) !== bytes.length - 8 ||
      tag(8) !== "WAVE" ||
      tag(12) !== "fmt " ||
      view.getUint32(16, true) !== 16 ||
      view.getUint16(20, true) !== 1 ||
      view.getUint16(22, true) !== 1 ||
      view.getUint32(24, true) !== 16000 ||
      view.getUint32(28, true) !== 32000 ||
      view.getUint16(32, true) !== 2 ||
      view.getUint16(34, true) !== 16 ||
      tag(36) !== "data" ||
      length !== bytes.length - 44 ||
      length < 6400 ||
      length > 192000 ||
      length % 2 !== 0
    )
      return reply(400, "invalid");
    if (!bytes.subarray(44).some((byte) => byte !== 0))
      return reply(422, "unrecognized");
    const prefix = encoder.encode(
      JSON.stringify(["voice-fingerprint-v1", action]),
    );
    fingerprintBytes = new Uint8Array(prefix.length + bytes.length);
    fingerprintBytes.set(prefix);
    fingerprintBytes.set(bytes, prefix.length);
  }

  const db = env.RECAP_DB;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(env.RECAP_HASH_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const hash = async (value: Uint8Array<ArrayBuffer>) => {
      const digest = await crypto.subtle.sign("HMAC", key, value);
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    };
    const [fingerprint, ipHash] = await Promise.all([
      hash(fingerprintBytes),
      hash(encoder.encode(JSON.stringify(["voice-ip-v1", ip]))),
    ]);
    const now = Math.floor(Date.now() / 1000);
    // Every state counts. The INSERT owns both limits and UUID uniqueness atomically.
    const results = await db.batch<{ id: string }>([
      db
        .prepare("DELETE FROM voice_requests WHERE created_at < ?")
        .bind(now - 48 * 3600),
      db
        .prepare(
          `INSERT INTO voice_requests (id, action, fingerprint, ip_hash, created_at, state)
        SELECT ?, ?, ?, ?, ?, 'pending'
        WHERE (SELECT COUNT(*) FROM voice_requests WHERE action = ? AND ip_hash = ? AND created_at >= ?) < 5
          AND (SELECT COUNT(*) FROM voice_requests WHERE action = ? AND created_at >= ?) < ?
        ON CONFLICT(id) DO NOTHING RETURNING id`,
        )
        .bind(
          requestId,
          action,
          fingerprint,
          ipHash,
          now,
          action,
          ipHash,
          now - 3600,
          action,
          Math.floor(now / 86400) * 86400,
          limit,
        ),
    ]);
    if (results.length !== 2 || results.some((result) => !result.success))
      return reply(503, "unavailable");
    if (results[1].results.length === 0) {
      const existing = await db
        .prepare("SELECT fingerprint FROM voice_requests WHERE id = ?")
        .bind(requestId)
        .first<{ fingerprint: string }>();
      if (!existing) return reply(429, "limited");
      return reply(
        409,
        existing.fingerprint === fingerprint ? "already_used" : "invalid",
      );
    }

    let state: "done" | "failed" | "unknown" = "unknown";
    let result = reply(503, "unavailable");
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      action === "greet" ? 20000 : 12000,
    );
    try {
      const headers = new Headers({
        Authorization: `Bearer ${env.MISTRAL_VOICE_API_KEY}`,
      });
      let body: string | FormData;
      if (action === "greet") {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify({
          model: TTS_MODEL,
          input: text,
          voice_id: VOICE_ID,
          expressiveness: VOICE_EXPRESSIVENESS,
          response_format: "mp3",
          stream: false,
        });
      } else {
        body = new FormData();
        body.set("model", TRANSCRIBE_MODEL);
        body.set(
          "file",
          new Blob([bytes], { type: "audio/wav" }),
          "prenom.wav",
        );
      }
      const response = await fetch(
        `https://api.mistral.ai/v1/audio/${action === "greet" ? "speech" : "transcriptions"}`,
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers,
          body,
        },
      );
      if (!response.ok) {
        state =
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408
            ? "failed"
            : "unknown";
        void response.body?.cancel().catch(() => {});
      } else if (
        response.headers
          .get("content-type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() !== "application/json"
      ) {
        void response.body?.cancel().catch(() => {});
      } else {
        const raw = await readBounded(
          response,
          action === "greet" ? 1024 * 1024 : 64 * 1024,
          controller.signal,
        );
        const data = raw ? json(raw) : null;
        if (action === "greet") {
          const base64 = data?.audio_data;
          if (
            typeof base64 === "string" &&
            base64.length > 0 &&
            base64.length <= 699052 &&
            base64.length % 4 === 0 &&
            /^[A-Za-z0-9+/]*={0,2}$/u.test(base64)
          ) {
            const decoded = atob(base64);
            const audio = Uint8Array.from(decoded, (char) =>
              char.charCodeAt(0),
            );
            const mp3 =
              audio.length >= 3 &&
              ((audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33) ||
                (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0));
            if (audio.length <= 512 * 1024 && btoa(decoded) === base64 && mp3) {
              state = "done";
              result = new Response(audio, {
                headers: {
                  "Content-Type": "audio/mpeg",
                  "Cache-Control": "no-store",
                },
              });
            }
          }
        } else if (typeof data?.text === "string") {
          // Deliberately conservative, fixed prefix stripping, never LLM extraction.
          // A rejected or ambiguous transcript falls back to the editable text field.
          const candidate = ([...data.text].length <= 200 ? data.text : "")
            .trim()
            .replace(/^bonjour(?:\s*[,!:.]\s*|\s+|$)/iu, "")
            .replace(
              /^(?:je m['’]appelle|moi c['’]est|mon prénom est|je suis|c['’]est)\s+/iu,
              "",
            )
            .replace(/[.!?…]+$/u, "")
            .trim();
          const name = normalizeName(candidate);
          const words = candidate.split(/\s+/u);
          const ambiguous =
            words.length > 4 ||
            /(?:^|[\s'’])(?:ou|et|bonjour|salut|merci|non|oui|je|moi|suis|appelle|est|pas|peut|peut-être|prénom|nom|inconnu|inaudible|silence|test|vous|tu|ça|va)(?:$|[\s'’])/iu.test(
              candidate,
            );
          state = "done";
          result =
            name && !ambiguous
              ? Response.json(
                  { ok: true, name },
                  { headers: { "Cache-Control": "no-store" } },
                )
              : reply(422, "unrecognized");
        }
      }
    } catch {
      // An interrupted request may have been billed. Keep the reservation, never retry.
      state = "unknown";
    } finally {
      clearTimeout(timeout);
    }
    try {
      await db
        .prepare(
          "UPDATE voice_requests SET state = ? WHERE id = ? AND state = 'pending'",
        )
        .bind(state, requestId)
        .run();
    } catch {
      // A pending row also blocks replay within the retention window.
    }
    return result;
  } catch {
    return reply(503, "unavailable");
  }
}
