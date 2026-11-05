import {
  INTRO_CAPTIONS,
  INTRO_FACE,
  INTRO_HANDOFF_SECONDS,
  PAINS,
  QUESTION,
  callbackEmails,
  displayPhone,
  normalizeName,
  normalizePhone,
} from "./chat-content.js";

// « Parler à Léa ». Léa's voice notes are fixed recordings; the visitor's
// first name, phone, e-mail and chosen answer go only to /api/recap.

const ICON = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 2.5v11l9-5.5z"/></svg>',
  pause:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3.5 2.5h3v11h-3zm6 0h3v11h-3z"/></svg>',
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
  let topic = "";
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
    void ask(ticket);
  }

  // ---------- 3. Léa asks what weighs on the days (voice note) ----------
  async function ask(ticket) {
    if (!(await typing(900, ticket))) return;
    const note = voiceNote({
      from: "lea",
      seed: QUESTION.text,
      text: QUESTION.text,
      src: QUESTION.audio,
      duration: QUESTION.seconds,
    });
    add(note.msg);
    say(`Léa : ${QUESTION.text}`);
    if (await note.play()) await finished();
    if (ticket !== run) return;
    await wait(reduced.matches ? 0 : 300);
    if (ticket !== run) return;
    choices(ticket);
  }

  // ---------- 4. The visitor picks an answer ----------
  function choices(ticket) {
    const msg = el("div", "msg from-lea choices");
    const list = el("div", "choice-list");
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", "Ce qui vous complique le plus la vie");
    PAINS.forEach((pain, index) => {
      const button = el("button", "choice");
      button.type = "button";
      button.style.setProperty("--i", String(index));
      const glyph = el("span", "choice-glyph", pain.glyph);
      glyph.setAttribute("aria-hidden", "true");
      const words = el("span", "choice-words");
      words.append(el("b", "", pain.label), el("small", "", pain.detail));
      button.append(glyph, words);
      button.addEventListener("click", () => void choose(pain, button, msg, ticket));
      list.append(button);
    });
    msg.append(list);
    add(msg);
    say("Choisissez ce qui vous complique le plus la vie.");
    // Focus the group, not a choice: no answer should look preselected.
    list.tabIndex = -1;
    list.focus({ preventScroll: true });
  }
  async function choose(pain, button, msg, ticket) {
    if (ticket !== run || msg.dataset.done) return;
    msg.dataset.done = "true";
    topic = pain.id;
    stopAudio();
    msg.querySelectorAll("button").forEach((choice) => {
      choice.disabled = true;
      choice.classList.toggle("is-chosen", choice === button);
    });
    await wait(reduced.matches ? 0 : 420);
    if (ticket !== run) return;
    msg.remove();
    text("me", pain.label);
    restart.focus({ preventScroll: true });
    await answer(pain, ticket);
  }

  // ---------- 5. Léa answers that answer (voice note) ----------
  async function answer(pain, ticket) {
    presence.textContent = "enregistre un vocal…";
    presence.classList.add("is-typing");
    await wait(reduced.matches ? 200 : 1400);
    presence.textContent = "Assistante virtuelle";
    presence.classList.remove("is-typing");
    if (ticket !== run) return;
    const note = voiceNote({
      from: "lea",
      seed: pain.reply,
      text: pain.reply,
      src: pain.audio,
      duration: pain.seconds,
    });
    add(note.msg);
    say(`Léa : ${pain.reply}`);
    if (await note.play()) await finished();
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
    const msg = el("div", "msg from-lea");
    const card = el("form", "card");
    card.noValidate = true;
    card.append(
      el("h3", "", "Être rappelé par Ruchée"),
      el("p", "", "Votre numéro pour vous rappeler, votre e-mail pour la confirmation."),
    );
    const first = field(card, "call-name", "Prénom", {
      type: "text",
      name: "given-name",
      autocomplete: "given-name",
      placeholder: "Sophie",
      maxLength: 60,
      required: true,
    });
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
    first.focus({ preventScroll: true });
    say("Laissez votre prénom, votre numéro et votre e-mail pour être rappelé.");

    card.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      [first, phone, email].forEach((input) => input.removeAttribute("aria-invalid"));
      const given = normalizeName(first.value);
      if (!given) {
        first.setAttribute("aria-invalid", "true");
        error.textContent = "Indiquez votre prénom avec des lettres (60 caractères maximum).";
        first.focus();
        return;
      }
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
          body: JSON.stringify({
            name: given,
            phone: tel,
            email: mail,
            topic,
            website: trap.value,
            requestId: recapId,
          }),
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
        name = given;
        msg.remove();
        await sent(tel, mail, ticket);
        return;
      }
      submit.disabled = false;
      submit.textContent = "Être rappelé";
      if (result?.code === "invalid") {
        error.textContent = "Vérifiez votre prénom, votre numéro et votre e-mail.";
        recapId = null;
        return;
      }
      if (result?.retryable) recapId = null;
      error.textContent = "";
      card.remove();
      msg.remove();
      name = given;
      await notSent(tel, ticket);
    });
  }

  // ---------- 7. The e-mail, shown as sent ----------
  async function sent(tel, mail, ticket) {
    const shown = displayPhone(tel);
    text("me", `${shown} · ${mail}`);
    await wait(reduced.matches ? 100 : 500);
    if (ticket !== run) return;
    const message = callbackEmails({ name, phone: tel, email: mail, topic }).visitor;
    const card = el("article", "msg mail");
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
    text("lea", `C’est noté, ${name}. Nous vous rappelons au ${shown}.`);
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
    );
    say("L’envoi n’a pas abouti. Écrivez-nous à contact@ruchee.fr.");
  }

  // ---------- Open / close / restart ----------
  function reset() {
    run++;
    stopAudio();
    video.pause();
    log.replaceChildren();
    name = "";
    topic = "";
    recapId = null;
  }
  function open(withSound) {
    if (dialog.open) return;
    // Unlock the shared <audio> inside the click, so later voice notes can play.
    if (withSound) {
      audio.muted = true;
      audio.src = QUESTION.audio;
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
