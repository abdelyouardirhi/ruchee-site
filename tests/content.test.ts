import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PAINS,
  QUESTION,
  TTS_MODEL,
  VOICE_CLIPS,
  VOICE_EXPRESSIVENESS,
  VOICE_ID,
  callbackEmails,
  painById,
} from "../chat-content.js";

const root = new URL("../", import.meta.url);

test("answer choices are unique, short and lead to the contact card", () => {
  assert.ok(PAINS.length >= 3 && PAINS.length <= 6);
  assert.equal(new Set(PAINS.map((pain) => pain.id)).size, PAINS.length);
  for (const pain of PAINS) {
    assert.match(pain.id, /^[a-z]+$/u);
    assert.ok(pain.label.length <= 40, pain.label);
    assert.ok(pain.detail.length <= 40, pain.detail);
    assert.ok(pain.reply.endsWith("nous vous rappelons pour en parler."));
    assert.equal(painById(pain.id), pain);
  }
  for (const value of ["", "ABSENCES", "constructor", "__proto__", null, 1])
    assert.equal(painById(value), null);
});

test("every voice clip exists and matches its text, model and cloned voice", async () => {
  assert.equal(VOICE_CLIPS.length, PAINS.length + 1);
  assert.equal(VOICE_CLIPS[0], QUESTION);
  for (const clip of VOICE_CLIPS) {
    const audio = await readFile(new URL(clip.audio, root));
    const metadata = JSON.parse(
      await readFile(new URL(`${clip.audio}.json`, root), "utf8"),
    );
    assert.equal(metadata.text, clip.text, clip.audio);
    assert.equal(metadata.model, TTS_MODEL);
    assert.equal(metadata.voiceId, VOICE_ID);
    assert.equal(metadata.expressiveness, VOICE_EXPRESSIVENESS);
    assert.equal(
      metadata.sha256,
      createHash("sha256").update(audio).digest("hex"),
    );
  }
});

test("both e-mails name the chosen answer", () => {
  const emails = callbackEmails({
    name: "Sophie",
    phone: "+33612345678",
    email: "sophie@example.test",
    topic: "recrutement",
  });
  assert.match(emails.team.text, /Recruter, encore et encore/u);
  assert.match(emails.visitor.text, /« recruter, encore et encore »/u);
  const all = callbackEmails({
    name: "Sophie",
    phone: "+33612345678",
    email: "sophie@example.test",
    topic: "tout",
  });
  assert.match(all.team.text, /Tout à la fois/u);
  assert.match(all.visitor.text, /« tout à la fois »/u);
});
