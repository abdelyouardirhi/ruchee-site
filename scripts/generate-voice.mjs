import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TTS_MODEL,
  VOICE_CLIPS,
  VOICE_ID,
  VOICE_EXPRESSIVENESS,
} from "../chat-content.js";

const MAX_AUDIO_BYTES = 1_000_000;
const MAX_JSON_BYTES = 1_500_000;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
class ControlledError extends Error {}

async function statIfPresent(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isMp3(bytes) {
  return (
    (bytes.length >= 10 &&
      bytes[0] === 0x49 &&
      bytes[1] === 0x44 &&
      bytes[2] === 0x33) ||
    (bytes.length >= 4 &&
      bytes[0] === 0xff &&
      (bytes[1] & 0xe0) === 0xe0 &&
      (bytes[1] & 0x18) !== 0x08 &&
      (bytes[1] & 0x06) === 0x02 &&
      (bytes[2] & 0xf0) !== 0xf0 &&
      (bytes[2] & 0x0c) !== 0x0c)
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--force")) {
    throw new ControlledError(
      "Usage: node scripts/generate-voice.mjs [--force]",
    );
  }
  const force = args.includes("--force");
  if (
    !VOICE_CLIPS.length ||
    VOICE_CLIPS.some(
      (clip) =>
        !/^audio\/[a-zA-Z0-9_-]+\.mp3$/u.test(clip.audio) ||
        typeof clip.text !== "string" ||
        !clip.text.trim() ||
        clip.text.length > 400,
    ) ||
    new Set(VOICE_CLIPS.map((clip) => clip.audio)).size !== VOICE_CLIPS.length ||
    VOICE_EXPRESSIVENESS !== 3
  ) {
    throw new ControlledError(
      "Invalid shared voice configuration; no request sent.",
    );
  }
  const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  const audioDir = path.join(root, "audio");
  await mkdir(audioDir, { recursive: true });
  if ((await realpath(audioDir)) !== audioDir) {
    throw new ControlledError(
      "Audio directory must not be a symlink; no request sent.",
    );
  }
  for (const clip of VOICE_CLIPS) await generate(root, clip, force);
}

async function generate(root, clip, force) {
  const target = path.join(root, clip.audio);
  const metadataFile = `${target}.json`;
  const lockFile = `${target}.lock`;
  let lock;
  try {
    // Prevent two invocations from paying for the same clip concurrently.
    lock = await open(lockFile, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new ControlledError(
        "Voice generation is locked; no request sent. Check for another running generator.",
      );
    }
    throw error;
  }
  const tempMetadata = `${metadataFile}.${randomUUID()}.tmp`;
  const tempAudio = `${target}.${randomUUID()}.tmp`;
  try {
    const existing = await statIfPresent(target);
    const existingMetadata = await statIfPresent(metadataFile);
    if (
      (existing && !existing.isFile()) ||
      (existingMetadata && !existingMetadata.isFile())
    ) {
      throw new ControlledError(
        "Audio and metadata must be regular files; no request sent.",
      );
    }
    if (existing && !force) {
      let matches = false;
      if (
        existing.size <= MAX_AUDIO_BYTES &&
        existingMetadata?.size <= 16_384
      ) {
        try {
          const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
          const audio = await readFile(target);
          matches =
            metadata.text === clip.text &&
            metadata.model === TTS_MODEL &&
            metadata.voiceId === VOICE_ID &&
            metadata.expressiveness === VOICE_EXPRESSIVENESS &&
            metadata.sha256 === sha256(audio) &&
            isMp3(audio);
        } catch {
          // Missing or unreadable metadata must never trigger another paid request.
        }
      }
      if (!matches) {
        throw new ControlledError(
          `${clip.audio} exists without matching metadata. Refusing regeneration; use --force only to authorize new requests.`,
        );
      }
      console.log(
        `Already exists: ${clip.audio}; metadata and SHA-256 match. No request sent.`,
      );
      return;
    }
    const key = process.env.MISTRAL_VOICE_API_KEY?.trim();
    if (!key) {
      throw new ControlledError(
        "MISTRAL_VOICE_API_KEY is missing; no request sent.",
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let audio;
    try {
      // Exactly one attempt. A timeout may still have incurred provider usage.
      const response = await fetch("https://api.mistral.ai/v1/audio/speech", {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: TTS_MODEL,
          input: clip.text,
          voice_id: VOICE_ID,
          expressiveness: VOICE_EXPRESSIVENESS,
          response_format: "mp3",
          stream: false,
        }),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new ControlledError(
          `Voice provider returned HTTP ${response.status}; no retry.`,
        );
      }
      if (!response.body)
        throw new ControlledError(
          "Voice provider returned no audio; no retry.",
        );
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > MAX_JSON_BYTES) {
          controller.abort();
          throw new ControlledError(
            "Voice provider response exceeded the size limit; no retry.",
          );
        }
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
      const encoded = data?.audio_data;
      if (
        typeof encoded !== "string" ||
        !encoded.length ||
        encoded.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
      ) {
        throw new ControlledError(
          "Voice provider returned invalid audio data; no retry.",
        );
      }
      audio = Buffer.from(encoded, "base64");
      if (
        audio.length > MAX_AUDIO_BYTES ||
        !isMp3(audio) ||
        audio.toString("base64") !== encoded
      ) {
        throw new ControlledError(
          "Voice provider returned invalid or oversized MP3 data; no retry.",
        );
      }
    } catch (error) {
      if (error instanceof ControlledError) throw error;
      throw new ControlledError(
        "Voice request failed, timed out, or returned invalid JSON; no retry.",
      );
    } finally {
      clearTimeout(timeout);
    }
    const hash = sha256(audio);
    const metadata = {
      text: clip.text,
      model: TTS_MODEL,
      voiceId: VOICE_ID,
      expressiveness: VOICE_EXPRESSIVENESS,
      sha256: hash,
      generatedAt: new Date().toISOString(),
    };
    await writeFile(tempMetadata, `${JSON.stringify(metadata, null, 2)}\n`, {
      flag: "wx",
    });
    if (force) {
      await writeFile(tempAudio, audio, { flag: "wx" });
      await rename(tempAudio, target);
    } else {
      await writeFile(target, audio, { flag: "wx" });
    }
    await rename(tempMetadata, metadataFile);
    console.log(
      `Generated ${clip.audio}: ${audio.length} bytes; SHA-256 ${hash}.`,
    );
  } finally {
    await Promise.all(
      [tempMetadata, tempAudio].map((file) => unlink(file).catch(() => {})),
    );
    await lock.close();
    await unlink(lockFile);
  }
}

main().catch((error) => {
  console.error(
    error instanceof ControlledError
      ? error.message
      : "Voice generation failed locally. Check files before retrying; no automatic retry.",
  );
  process.exitCode = 1;
});
