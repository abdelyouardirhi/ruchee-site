import {
  INTRO_CAPTIONS,
  INTRO_FACE,
  INTRO_HANDOFF_SECONDS,
  MAX_RECORDING_SECONDS,
  WELCOME_AUDIO,
  WELCOME_TEXT,
  callbackEmails,
  displayPhone,
  normalizeName,
  normalizePhone,
  personalizedReply,
} from "./chat-content.js";

// « Parler à Léa ». Only fixed copy and a confirmed first name reach the voice
// service; the visitor's phone and e-mail go only to /api/recap.

const ICON = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 2.5v11l9-5.5z"/></svg>',
  pause:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3.5 2.5h3v11h-3zm6 0h3v11h-3z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 1 0-7 0v6A3.5 3.5 0 0 0 12 15Zm6-3.5a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.9V20H8.5a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H13v-2.6a6 6 0 0 0 5-5.9Z"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3a1 1 0 0 1 .7.3l6 6a1 1 0 1 1-1.4 1.4L13 6.4V20a1 1 0 1 1-2 0V6.4l-4.3 4.3a1 1 0 0 1-1.4-1.4l6-6A1 1 0 0 1 12 3Z"/></svg>',
};

const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Deterministic bar heights, so a voice note always looks the same.
function bars(seed, count = 28) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Array.from({ length: count }, (_, i) => {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    const wave = Math.sin((i / count) * Math.PI);
    return 0.25 + 0.75 * wave * (0.45 + ((h >>> 0) % 1000) / 1800);
  });
}

function init() {
  const dialog = document.getElementById("lea-call");
  const fallback = document.querySelector("#parler-a-lea[data-chat-fallback]");
  if (!dialog || typeof dialog.showModal !== "function") return;

  const screen = dialog.querySelector(".call-screen");
  const intro = dialog.querySelector(".call-intro");
  const video = intro.querySelector("video");
  const caption = intro.querySelector(".call-caption");
  const skip = intro.querySelector("[data-call-skip]");
  const sound = intro.querySelector("[data-call-sound]");
  const chat = dialog.querySelector(".call-chat");
  const avatar = chat.querySelector(".chat-avatar");
  const presence = chat.querySelector("[data-call-presence]");
  const log = chat.querySelector(".chat-log");
  const composer = chat.querySelector(".chat-composer");
  const restart = chat.querySelector("[data-call-restart]");
  const closeButton = dialog.querySelector("[data-call-close]");
  const status = dialog.querySelector("[data-call-status]");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  // One shared <audio>, unlocked in the opening click, plays every voice note.
  const audio = new Audio();
  audio.preload = "auto";
  let playing = null;
  let run = 0; // bumps on close/restart: stale async steps stop themselves
  let stage = "idle"; // idle | intro | chat
  let name = "";
  let mic = null;
  let context = null;
  let workletReady = null;
  const greetings = new Map();
  let recapId = null;

  const say = (text) => {
    status.textContent = "";
    window.setTimeout(() => (status.textContent = text), 30);
  };
  const scrollDown = () =>
    log.scrollTo({ top: log.scrollHeight, behavior: reduced.matches ? "auto" : "smooth" });

  // ---------- Voice notes ----------
  function stopAudio() {
    audio.pause();
    if (playing) playing.update(false);
    playing = null;
  }
  function voiceNote({ from, seed, text, src, duration, pending = false }) {
    const msg = el("div", `msg from-${from}`);
    const bubble = el("div", "bubble");
    const row = el("div", "note");
    const button = el("button", "note-play");
    button.type = "button";
    const wave = el("div", "note-wave");
    wave.setAttribute("aria-hidden", "true");
    const heights = bars(seed);
    const ticks = heights.map((value) => {
      const i = el("i");
      i.style.height = `${Math.round(value * 100)}%`;
      wave.append(i);
      return i;
    });
    const time = el("span", "note-time", duration ? clock(duration) : "0:00");
    row.append(button, wave, time);
    const transcript = el("p", `note-text${pending ? " is-pending" : ""}`, text);
    bubble.append(row, transcript);
    msg.append(bubble);
    const note = {
      msg,
      src,
      setText(value, done = true) {
        transcript.textContent = value;
        transcript.classList.toggle("is-pending", !done);
      },
      duration(seconds) {
        time.textContent = clock(seconds);
      },
      progress(ratio) {
        const lit = Math.round(ratio * ticks.length);
        ticks.forEach((tick, i) => tick.classList.toggle("on", i < lit));
      },
      update(on) {
        button.innerHTML = on ? ICON.pause : ICON.play;
        button.setAttribute(
          "aria-label",
          on ? "Mettre en pause" : from === "lea" ? "Écouter le message de Léa" : "Réécouter votre message",
        );
        if (!on) this.progress(0);
      },
      play() {
        if (!this.src) return Promise.resolve(false);
        stopAudio();
        playing = this;
        audio.src = this.src;
        this.update(true);
        return audio.play().then(
          () => true,
          () => {
            this.update(false);
            playing = null;
            return false;
          },
        );
      },
    };
    note.update(false);
    button.addEventListener("click", () => {
      if (playing === note && !audio.paused) stopAudio();
      else void note.play();
    });
    if (!src) button.disabled = true;
    return note;
  }
  audio.addEventListener("loadedmetadata", () => {
    if (playing && Number.isFinite(audio.duration)) playing.duration(audio.duration);
  });
  audio.addEventListener("timeupdate", () => {
    if (playing && audio.duration) playing.progress(audio.currentTime / audio.duration);
  });
  audio.addEventListener("ended", () => stopAudio());
  const finished = () =>
    new Promise((resolve) => {
      if (audio.paused) return resolve();
      const done = () => {
        audio.removeEventListener("ended", done);
        audio.removeEventListener("pause", done);
        resolve();
      };
      audio.addEventListener("ended", done);
      audio.addEventListener("pause", done);
    });

  // ---------- Chat helpers ----------
  function add(node) {
    log.append(node);
    scrollDown();
    return node;
  }
  function text(from, value, html = false) {
    const msg = el("div", `msg from-${from}`);
    const bubble = el("div", "bubble");
    const p = el("p");
    if (html) p.append(...value);
    else p.textContent = value;
    bubble.append(p);
    msg.append(bubble);
    return add(msg);
  }
  async function typing(ms, ticket) {
    presence.textContent = "écrit…";
    presence.classList.add("is-typing");
    const dots = add(el("div", "msg from-lea typing"));
    const bubble = el("div", "bubble");
    bubble.append(el("i"), el("i"), el("i"));
    bubble.setAttribute("aria-label", "Léa écrit");
    dots.append(bubble);
    await wait(reduced.matches ? 200 : ms);
    dots.remove();
    presence.textContent = "Assistante virtuelle";
    presence.classList.remove("is-typing");
    return ticket === run;
  }

  // ---------- 1. Intro video ----------
  function fitVideo() {
    const W = screen.clientWidth;
    const H = screen.clientHeight;
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const scale = Math.max(W / vw, H / vh);
    const w = vw * scale;
    const h = vh * scale;
    const ox = Math.min(0, Math.max(W - w, W / 2 - INTRO_FACE.x * w));
    const oy = Math.min(0, Math.max(H - h, H * 0.36 - INTRO_FACE.y * h));
    video.style.objectPosition = `${ox}px ${oy}px`;
    return { cx: ox + INTRO_FACE.x * w, cy: oy + INTRO_FACE.y * h, r: INTRO_FACE.radius * h };
  }
  function showCaption() {
    const t = video.currentTime;
    const line = INTRO_CAPTIONS.find((c) => t >= c.start && t <= c.end);
    caption.textContent = line ? line.text : "";
  }
  function startIntro(withSound) {
    stage = "intro";
    intro.hidden = false;
    intro.classList.remove("is-closing");
    intro.style.clipPath = "";
    intro.style.transform = "";
    chat.hidden = true;
    caption.textContent = "";
    video.currentTime = 0;
    video.muted = !withSound;
    sound.hidden = withSound;
    fitVideo();
    const played = video.play();
    played?.catch(() => {
      // Sound refused (no click, or browser policy): play muted, offer sound.
      video.muted = true;
      sound.hidden = false;
      video.play().catch(() => void handoff());
    });
  }
  video.addEventListener("loadedmetadata", fitVideo);
  video.addEventListener("timeupdate", () => {
    if (stage !== "intro") return;
    showCaption();
    if (video.currentTime >= INTRO_HANDOFF_SECONDS) void handoff();
  });
  video.addEventListener("ended", () => void handoff());
  video.addEventListener("error", () => void handoff());
  skip.addEventListener("click", () => void handoff());
  sound.addEventListener("click", () => {
    video.muted = false;
    sound.hidden = true;
    void video.play().catch(() => {});
  });

  // ---------- 2. The circle: face → chat avatar ----------
  async function handoff() {
    if (stage !== "intro") return;
    stage = "chat";
    const ticket = run;
    chat.hidden = false;
    chat.classList.add("is-arriving");
    restart.hidden = true;
    composer.hidden = true;
    if (!log.childElementCount) log.append(el("p", "chat-day", "Aujourd’hui"));
    intro.classList.add("is-closing");
    const { cx, cy, r } = fitVideo();
    const target = avatar.getBoundingClientRect();
    const box = screen.getBoundingClientRect();
    const ax = target.left - box.left + target.width / 2;
    const ay = target.top - box.top + target.height / 2;
    const far = Math.hypot(screen.clientWidth, screen.clientHeight);
    if (!reduced.matches && intro.animate) {
      try {
        await intro.animate(
          [
            { clipPath: `circle(${far}px at ${cx}px ${cy}px)` },
            { clipPath: `circle(${r}px at ${cx}px ${cy}px)` },
          ],
          { duration: 750, easing: "cubic-bezier(.65,0,.35,1)", fill: "forwards" },
        ).finished;
        if (ticket !== run) return;
        intro.style.transformOrigin = `${cx}px ${cy}px`;
        await intro.animate(
          [
            { transform: "none" },
            {
              transform: `translate(${ax - cx}px, ${ay - cy}px) scale(${target.width / 2 / r})`,
            },
          ],
          { duration: 650, easing: "cubic-bezier(.3,.8,.2,1)", fill: "forwards" },
        ).finished;
      } catch {
        /* An interrupted animation still lands on the chat. */
      }
    }
    if (ticket !== run) return;
    chat.classList.remove("is-arriving");
    video.pause();
    intro.getAnimations?.().forEach((a) => a.cancel());
    intro.hidden = true;
    restart.hidden = false;
    void askName(ticket);
  }

  // ---------- 3. Léa asks the name (voice note) ----------
  async function askName(ticket) {
    if (!(await typing(900, ticket))) return;
    const note = voiceNote({
      from: "lea",
      seed: WELCOME_TEXT,
      text: WELCOME_TEXT,
      src: WELCOME_AUDIO,
      duration: 2,
    });
    add(note.msg);
    say(`Léa : ${WELCOME_TEXT}`);
    const started = await note.play();
    if (started) await finished();
    if (ticket !== run) return;
    voiceComposer();
  }

  // ---------- 4. Visitor answers by voice (or text) ----------
  function voiceComposer(error = "") {
    composer.hidden = false;
    composer.replaceChildren();
    const row = el("div", "composer-voice");
    const hint = el("p", "composer-hint");
    hint.append("Touchez le micro et dites votre prénom. ");
    const write = el("button", "", "Écrire plutôt");
    write.type = "button";
    write.addEventListener("click", () => textComposer());
    hint.append(write);
    const button = el("button", "mic is-ready");
    button.type = "button";
    button.innerHTML = ICON.mic;
    button.setAttribute("aria-label", "Dire mon prénom au micro");
    button.addEventListener("click", () => void record());
    row.append(hint, button);
    composer.append(row, el("p", "composer-error", error));
    button.focus({ preventScroll: true });
  }
  function textComposer(error = "", value = "") {
    stopMic();
    composer.hidden = false;
    composer.replaceChildren();
    const form = el("form", "composer-text");
    form.noValidate = true;
    const input = el("input");
    input.type = "text";
    input.name = "prenom";
    input.autocomplete = "given-name";
    input.placeholder = "Votre prénom";
    input.maxLength = 60;
    input.value = value;
    input.setAttribute("aria-label", "Votre prénom");
    const send = el("button", "send");
    send.type = "submit";
    send.innerHTML = ICON.send;
    send.setAttribute("aria-label", "Envoyer mon prénom");
    form.append(input, send);
    const message = el("p", "composer-error", error);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = normalizeName(input.value);
      if (!value) {
        message.textContent = "Indiquez votre prénom avec des lettres (60 caractères maximum).";
        input.setAttribute("aria-invalid", "true");
        return;
      }
      composer.hidden = true;
      text("me", value);
      void greet(value, run);
    });
    composer.append(form, message);
    input.focus({ preventScroll: true });
  }

  function stopMic() {
    if (!mic) return;
    window.clearTimeout(mic.timer);
    window.cancelAnimationFrame(mic.frame);
    mic.stream?.getTracks().forEach((t) => t.stop());
    if (mic.node) {
      mic.node.port.onmessage = null;
      mic.node.port.postMessage({ type: "cancel" });
      mic.node.disconnect();
    }
    mic.input?.disconnect();
    mic.analyser?.disconnect();
    mic.mute?.disconnect();
    mic.chunks.forEach((c) => c.fill(0));
    mic = null;
  }

  async function record() {
    if (mic) return;
    stopAudio();
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!navigator.mediaDevices?.getUserMedia || !AudioContext || !window.AudioWorkletNode) {
      textComposer("Le micro n’est pas disponible ici. Écrivez votre prénom.");
      return;
    }
    const ticket = run;
    context ||= new AudioContext();
    const resumed = context.resume().catch(() => {});
    const current = { chunks: [], samples: 0, levels: [] };
    mic = current;
    composer.replaceChildren(el("p", "composer-hint", "Autorisez le micro pour dire votre prénom…"));
    try {
      current.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      await resumed;
      workletReady ||= context.audioWorklet.addModule(
        new URL("./voice-recorder.worklet.js", import.meta.url),
      );
      await workletReady;
      if (mic !== current || ticket !== run) return;
      current.input = context.createMediaStreamSource(current.stream);
      current.node = new AudioWorkletNode(context, "voice-recorder", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { maxSeconds: MAX_RECORDING_SECONDS },
      });
      current.analyser = context.createAnalyser();
      current.analyser.fftSize = 256;
      current.mute = context.createGain();
      current.mute.gain.value = 0;
      current.node.port.onmessage = ({ data }) => {
        if (mic !== current) return;
        if (data.type === "samples") {
          current.chunks.push(data.samples);
          current.samples += data.samples.length;
        } else if (data.type === "done") void finishRecording(current);
      };
      current.input.connect(current.analyser);
      current.analyser.connect(current.node);
      current.node.connect(current.mute);
      current.mute.connect(context.destination);
    } catch {
      if (mic === current) stopMic();
      if (ticket === run)
        textComposer("Le micro n’a pas pu démarrer. Vous pouvez écrire votre prénom.");
      return;
    }
    // Recording UI: cancel · level · timer · send
    const row = el("div", "composer-rec");
    const cancel = el("button", "rec-cancel", "✕");
    cancel.type = "button";
    cancel.setAttribute("aria-label", "Annuler l’enregistrement");
    cancel.addEventListener("click", () => {
      stopMic();
      voiceComposer();
    });
    const level = el("div", "rec-level");
    level.setAttribute("aria-hidden", "true");
    const ticks = Array.from({ length: 24 }, () => level.appendChild(el("i")));
    const timer = el("span", "rec-time", "0:00");
    const send = el("button", "send");
    send.type = "button";
    send.style.width = send.style.height = "56px";
    send.innerHTML = ICON.send;
    send.setAttribute("aria-label", "Envoyer mon message vocal");
    send.addEventListener("click", () => {
      send.disabled = true;
      current.node?.port.postMessage({ type: "stop" });
      window.setTimeout(() => void finishRecording(current), 200);
    });
    row.append(cancel, level, timer, send);
    composer.replaceChildren(row, el("p", "composer-error"));
    send.focus({ preventScroll: true });
    say("Micro ouvert. Dites votre prénom, puis touchez Envoyer.");
    const buffer = new Float32Array(current.analyser.fftSize);
    const started = performance.now();
    const draw = () => {
      if (mic !== current) return;
      current.analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (const v of buffer) sum += v * v;
      const rms = Math.min(1, Math.sqrt(sum / buffer.length) * 6);
      current.levels.push(rms);
      ticks.forEach((tick, i) => {
        const v = current.levels[current.levels.length - ticks.length + i] ?? 0;
        tick.style.height = `${4 + v * 26}px`;
      });
      timer.textContent = clock((performance.now() - started) / 1000);
      current.frame = window.requestAnimationFrame(draw);
    };
    draw();
    current.timer = window.setTimeout(
      () => current.node?.port.postMessage({ type: "stop" }),
      MAX_RECORDING_SECONDS * 1000,
    );
  }

  function wav(current) {
    const rate = context.sampleRate;
    if (current.samples < rate * 0.4) throw new Error("short");
    const samples = new Float32Array(current.samples);
    let offset = 0;
    for (const c of current.chunks) {
      samples.set(c, offset);
      offset += c.length;
    }
    const count = Math.min(16000 * MAX_RECORDING_SECONDS, Math.floor((samples.length * 16000) / rate));
    const buffer = new ArrayBuffer(44 + count * 2);
    const view = new DataView(buffer);
    const ascii = (at, s) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
    ascii(0, "RIFF");
    view.setUint32(4, 36 + count * 2, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, count * 2, true);
    // Averaging resampler (box filter) to 16 kHz mono PCM16.
    const ratio = rate / 16000;
    for (let i = 0; i < count; i++) {
      const from = Math.floor(i * ratio);
      const to = Math.max(from + 1, Math.floor((i + 1) * ratio));
      let v = 0;
      for (let j = from; j < to && j < samples.length; j++) v += samples[j];
      v = Math.max(-1, Math.min(1, v / (to - from)));
      view.setInt16(44 + i * 2, Math.round(v * (v < 0 ? 32768 : 32767)), true);
    }
    samples.fill(0);
    return buffer;
  }

  async function finishRecording(current) {
    if (mic !== current || current.done) return;
    current.done = true;
    const ticket = run;
    const seconds = current.samples / context.sampleRate;
    let body;
    try {
      body = wav(current);
    } catch {
      stopMic();
      voiceComposer("Je n’ai rien entendu. Touchez le micro et parlez un peu plus longtemps.");
      return;
    }
    const recorded = new Blob([body.slice(0)], { type: "audio/wav" });
    stopMic();
    composer.hidden = true;
    const note = voiceNote({
      from: "me",
      seed: String(seconds),
      text: "Transcription…",
      src: URL.createObjectURL(recorded),
      duration: seconds,
      pending: true,
    });
    add(note.msg);
    let value = null;
    try {
      const response = await fetch("/api/voice?action=transcribe", {
        method: "POST",
        headers: {
          "Content-Type": "audio/wav",
          "X-Voice-Request-Id": crypto.randomUUID(),
          "X-Voice-Website": "",
        },
        body,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout?.(25000),
      });
      if (response.ok) {
        const result = await response.json();
        value = result?.ok === true ? normalizeName(result.name) : null;
      }
    } catch {
      value = null;
    } finally {
      new Uint8Array(body).fill(0);
    }
    if (ticket !== run) return;
    if (!value) {
      note.setText("Prénom non reconnu");
      if (!(await typing(700, ticket))) return;
      text("lea", "Je n’ai pas bien entendu. Écrivez-moi votre prénom ici.");
      textComposer();
      return;
    }
    note.setText(value);
    const meta = el("p", "msg-meta");
    const edit = el("button", "", "Ce n’est pas ça ? Corriger");
    edit.type = "button";
    edit.addEventListener("click", () => {
      run++;
      stopAudio();
      meta.remove();
      log.querySelectorAll(".after-name").forEach((n) => n.remove());
      textComposer("", value);
    });
    meta.append(edit);
    note.msg.append(meta);
    void greet(value, ticket);
  }

  // ---------- 5. Léa: « Bonjour X… » (personalized voice note) ----------
  async function loadGreeting(value) {
    if (!greetings.has(value)) {
      greetings.set(
        value,
        (async () => {
          const response = await fetch("/api/voice?action=greet", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: value, requestId: crypto.randomUUID(), website: "" }),
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout?.(25000),
          });
          if (!response.ok || !response.headers.get("content-type")?.startsWith("audio/mpeg"))
            throw new Error("voice");
          return URL.createObjectURL(await response.blob());
        })(),
      );
    }
    return greetings.get(value);
  }
  async function greet(value, ticket) {
    name = value;
    const reply = personalizedReply(value);
    const pending = loadGreeting(value).catch(() => null);
    presence.textContent = "enregistre un vocal…";
    const [src] = await Promise.all([pending, wait(reduced.matches ? 200 : 1200)]);
    presence.textContent = "Assistante virtuelle";
    if (ticket !== run) return;
    if (src) {
      const note = voiceNote({ from: "lea", seed: reply, text: reply, src, duration: 7 });
      note.msg.classList.add("after-name");
      add(note.msg);
      say(`Léa : ${reply}`);
      if (await note.play()) await finished();
    } else {
      if (!(await typing(800, ticket))) return;
      text("lea", reply).classList.add("after-name");
      say(`Léa : ${reply}`);
      await wait(1200);
    }
    if (ticket !== run) return;
    contactCard(ticket);
  }

  // ---------- 6. Contact card ----------
  function field(form, id, label, attrs) {
    const lab = el("label", "", label);
    lab.htmlFor = id;
    const input = el("input");
    input.id = id;
    Object.assign(input, attrs);
    form.append(lab, input);
    return input;
  }
  function contactCard(ticket) {
    const msg = el("div", "msg from-lea after-name");
    const card = el("form", "card");
    card.noValidate = true;
    card.append(
      el("h3", "", "Être rappelé par Ruchée"),
      el("p", "", "Votre numéro pour vous rappeler, votre e-mail pour la confirmation."),
    );
    const phone = field(card, "call-phone", "Téléphone", {
      type: "tel",
      name: "tel",
      autocomplete: "tel",
      inputMode: "tel",
      placeholder: "06 12 34 56 78",
      maxLength: 32,
      required: true,
    });
    const email = field(card, "call-email", "E-mail", {
      type: "email",
      name: "email",
      autocomplete: "email",
      inputMode: "email",
      placeholder: "vous@entreprise.fr",
      maxLength: 254,
      required: true,
    });
    const trap = el("input", "trap");
    trap.tabIndex = -1;
    trap.autocomplete = "off";
    trap.name = "website";
    trap.setAttribute("aria-hidden", "true");
    const submit = el("button", "card-submit", "Être rappelé");
    submit.type = "submit";
    const error = el("p", "card-error");
    error.setAttribute("role", "alert");
    const fine = el("p", "card-fine");
    const privacy = el("a", "", "Confidentialité");
    privacy.href = "confidentialite.html";
    privacy.target = "_blank";
    privacy.rel = "noopener";
    fine.append(
      "Un e-mail de confirmation pour vous, une copie pour l’équipe Ruchée qui vous rappelle. Pas de newsletter. ",
      privacy,
    );
    card.append(trap, submit, error, fine);
    msg.append(card);
    add(msg);
    phone.focus({ preventScroll: true });
    say("Laissez votre numéro et votre e-mail pour être rappelé.");

    card.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      phone.removeAttribute("aria-invalid");
      email.removeAttribute("aria-invalid");
      const tel = normalizePhone(phone.value);
      const mail = email.value.trim().toLowerCase();
      if (!tel) {
        phone.setAttribute("aria-invalid", "true");
        error.textContent = "Indiquez un numéro valide, par exemple 06 12 34 56 78.";
        phone.focus();
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,63}$/iu.test(mail) || mail.length > 254) {
        email.setAttribute("aria-invalid", "true");
        error.textContent = "Indiquez une adresse e-mail valide.";
        email.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = "Envoi…";
      recapId ||= crypto.randomUUID();
      let result = null;
      try {
        const response = await fetch("/api/recap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, phone: tel, email: mail, website: trap.value, requestId: recapId }),
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout?.(20000),
        });
        result = await response.json().catch(() => null);
      } catch {
        result = null;
      }
      if (ticket !== run) return;
      if (result?.ok) {
        msg.remove();
        await sent(tel, mail, ticket);
        return;
      }
      submit.disabled = false;
      submit.textContent = "Être rappelé";
      if (result?.code === "invalid") {
        error.textContent = "Vérifiez votre numéro et votre e-mail.";
        recapId = null;
        return;
      }
      if (result?.retryable) recapId = null;
      error.textContent = "";
      card.remove();
      msg.remove();
      await notSent(tel, ticket);
    });
  }

  // ---------- 7. The e-mail, shown as sent ----------
  async function sent(tel, mail, ticket) {
    const shown = displayPhone(tel);
    text("me", `${shown} · ${mail}`).classList.add("after-name");
    await wait(reduced.matches ? 100 : 500);
    if (ticket !== run) return;
    const message = callbackEmails({ name, phone: tel, email: mail }).visitor;
    const card = el("article", "msg mail after-name");
    card.setAttribute("aria-label", "E-mail envoyé");
    const top = el("div", "mail-top");
    top.append(el("span", "", "E-mail"), el("span", "mail-sent", "Envoyé ✓"));
    const dl = el("dl");
    for (const [k, v] of [
      ["De", "Léa · Ruchée"],
      ["À", mail],
      ["Copie", "Équipe Ruchée"],
      ["Objet", message.subject],
    ])
      dl.append(el("dt", "", k), el("dd", "", v));
    const body = message.text.split("\n\n").slice(0, 3).join("\n\n");
    card.append(top, dl, el("p", "mail-body", body));
    add(card);
    if (!(await typing(900, ticket))) return;
    text("lea", `C’est noté, ${name}. Nous vous rappelons au ${shown}.`).classList.add("after-name");
    say(`E-mail envoyé. Nous vous rappelons au ${shown}.`);
  }
  async function notSent(tel, ticket) {
    if (!(await typing(700, ticket))) return;
    const link = el("a", "", "contact@ruchee.fr");
    const subject = encodeURIComponent(`À rappeler : ${name}`);
    const body = encodeURIComponent(`Bonjour,\n\nMerci de me rappeler au ${displayPhone(tel)}.\n\n${name}`);
    link.href = `mailto:contact@ruchee.fr?subject=${subject}&body=${body}`;
    text(
      "lea",
      ["L’envoi n’a pas abouti. Écrivez-nous à ", link, " : nous vous rappelons au plus vite."],
      true,
    ).classList.add("after-name");
    say("L’envoi n’a pas abouti. Écrivez-nous à contact@ruchee.fr.");
  }

  // ---------- Open / close / restart ----------
  function reset() {
    run++;
    stopAudio();
    stopMic();
    video.pause();
    log.replaceChildren();
    composer.replaceChildren();
    composer.hidden = true;
    name = "";
    recapId = null;
  }
  function open(withSound) {
    if (dialog.open) return;
    // Unlock the shared <audio> inside the click, so later voice notes can play.
    if (withSound) {
      audio.muted = true;
      audio.src = WELCOME_AUDIO;
      audio.play().then(
        () => {
          audio.pause();
          audio.muted = false;
        },
        () => (audio.muted = false),
      );
    }
    dialog.showModal();
    document.documentElement.style.overflow = "hidden";
    if (stage === "idle") startIntro(withSound);
    closeButton.focus({ preventScroll: true });
  }
  function close() {
    stopAudio();
    if (mic) {
      stopMic();
      voiceComposer();
    }
    video.pause();
    if (stage === "intro") {
      stage = "idle";
      run++;
    }
    if (dialog.open) dialog.close();
    document.documentElement.style.overflow = "";
    if (window.location.hash === "#parler-a-lea")
      history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  closeButton.addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close(); // click on the blurred page
  });
  restart.addEventListener("click", () => {
    reset();
    stage = "idle";
    startIntro(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden || !dialog.open) return;
    stopAudio();
    if (mic) {
      stopMic();
      voiceComposer();
    }
    video.pause();
  });
  window.addEventListener("resize", () => {
    if (stage === "intro") fitVideo();
  });

  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[data-lea-open]") : null;
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    open(event.isTrusted);
  });
  window.addEventListener("hashchange", () => {
    if (window.location.hash === "#parler-a-lea") open(false);
  });
  if (fallback) fallback.hidden = true;
  if (window.location.hash === "#parler-a-lea") open(false);
}

try {
  init();
} catch {
  const fallback = document.querySelector("#parler-a-lea[data-chat-fallback]");
  if (fallback) fallback.hidden = false;
}
