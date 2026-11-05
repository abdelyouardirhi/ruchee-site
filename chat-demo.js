import {
  WELCOME_TEXT,
  WELCOME_AUDIO,
  personalizedReply,
  normalizeName,
  MAX_RECORDING_SECONDS,
} from "./chat-content.js";

// Only fixed copy and a confirmed first name reach the voice service.
async function initialize() {
  if (document.readyState === "loading") {
    await new Promise((resolve) =>
      document.addEventListener("DOMContentLoaded", resolve, { once: true }),
    );
  }
  const stylesheet = document.getElementById("chat-demo-styles");
  const dialog = document.getElementById("lea-chat");
  const fallback = document.querySelector("#parler-a-lea[data-chat-fallback]");
  const log = dialog?.querySelector("[data-chat-log]");
  const composer = dialog?.querySelector("[data-chat-composer]");
  const reset = dialog?.querySelector("[data-chat-reset]");
  const close = dialog?.querySelector("[data-chat-close]");
  const status = dialog?.querySelector("[data-chat-status]");
  const orb = dialog?.querySelector("[data-lea-orb]");
  const caption = dialog?.querySelector("[data-voice-state]");
  if (
    !stylesheet ||
    !fallback ||
    !log ||
    !composer ||
    !reset ||
    !close ||
    !status ||
    typeof dialog?.showModal !== "function"
  )
    return;

  const styled = await new Promise((resolve) => {
    let timeout;
    const finish = (ready) => {
      stylesheet.removeEventListener("load", loaded);
      stylesheet.removeEventListener("error", failed);
      window.clearTimeout(timeout);
      resolve(ready);
    };
    const loaded = () => finish(Boolean(stylesheet.sheet));
    const failed = () => finish(false);
    stylesheet.addEventListener("load", loaded);
    stylesheet.addEventListener("error", failed);
    timeout = window.setTimeout(failed, 10000);
    if (stylesheet.sheet) finish(true);
  });
  if (!styled) return;
  stylesheet.media = "all";
  log.setAttribute("role", "log");

  const viewport = window.visualViewport;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let orbTransition;
  let history;
  const greetings = new Map();
  const recapRequests = new Map();
  let context;
  let workletReady;
  let welcomeAudio;
  let welcome;
  let nameForm;
  let reply;
  let userMessage;
  let editName;
  let continueButton;
  let emailCard;
  let name = "";
  let phase = "welcome";
  let generation = 0;
  let playIntent = 0;
  let playback;
  let frame = 0;
  let micGeneration = 0;
  let capture;
  let transcription;
  let micBusy = false;
  let micUnavailable = false;
  let sending = false;
  let accepted = false;
  let sessionOpen = false;
  let everOpened = false;
  let invoker;
  let previousOverflow = "";
  let previousOverflowPriority = "";
  let reading = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, className, action) {
    const node = element("button", className, text);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }
  function nearBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  }
  function updateLog(action, force = false) {
    const follow = force || (!reading && nearBottom());
    action();
    if (dialog.open && follow) log.scrollTop = log.scrollHeight;
  }
  function announce(text) {
    status.textContent = text;
  }
  function setPhase(next) {
    const before = orb?.getBoundingClientRect();
    orbTransition?.cancel();
    phase = next;
    dialog.dataset.chatPhase = next;
    if (orb && before?.width && dialog.open && !reducedMotion.matches) {
      const after = orb.getBoundingClientRect();
      if (
        after.width &&
        (Math.abs(before.top - after.top) > 1 ||
          Math.abs(before.width - after.width) > 1)
      ) {
        orbTransition = orb.animate(
          [
            {
              transformOrigin: "top left",
              transform: `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width})`,
            },
            { transformOrigin: "top left", transform: "none" },
          ],
          { duration: 460, easing: "cubic-bezier(.22,1,.36,1)" },
        );
      }
    }
  }
  function voiceState(state, text) {
    dialog.dataset.voiceState = state;
    if (caption) caption.textContent = text;
    if (state !== "speaking" && state !== "listening")
      orb?.style.setProperty("--voice-level", "0");
  }
  function idleState() {
    voiceState(
      "idle",
      name ? "Un message pour vous" : "Écrivez ou dites votre prénom",
    );
  }
  function message(speaker, text) {
    const article = element(
      "article",
      `voice-message voice-message--${speaker}`,
    );
    const body = element("div", "voice-message-body");
    body.append(element("p", "", text));
    article.append(body);
    updateLog(() => log.append(article));
    return { article, body };
  }
  function presentMessage(assistant, first, second, summary, transcript) {
    const heading = element("h3", "voice-title");
    heading.append(
      element("span", "voice-title-prefix", first),
      document.createTextNode(" "),
      element("span", "voice-title-focus", second),
    );
    const copy = assistant.body.querySelector("p");
    copy.className = "voice-summary";
    copy.textContent = summary;
    assistant.body.prepend(heading);
    const details = element("details", "voice-transcript");
    details.append(
      element("summary", "", "Lire le message"),
      element("p", "", transcript),
    );
    return details;
  }
  function clock(seconds) {
    const value = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  }

  // Called in the trusted handler, before any fetch/decode/permission await.
  function unlockAudio() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return Promise.resolve(false);
      if (!context) {
        context = new AudioContext();
        context.addEventListener("statechange", () => {
          if (context.state === "running") return;
          if (playback) {
            const player = playback.player;
            stopPlayback(true);
            playbackError(
              player,
              "Le son a été interrompu. Touchez Écouter pour reprendre.",
            );
          }
          if (capture?.active) {
            cancelMicrophone();
            formError(
              nameForm,
              "Le micro a été interrompu. Vous pouvez écrire votre prénom.",
            );
          }
        });
      }
      const resumed = context.resume();
      return new Promise((resolve) => {
        const timeout = window.setTimeout(() => resolve(false), 2000);
        const finish = (allowed) => {
          window.clearTimeout(timeout);
          resolve(allowed);
        };
        Promise.resolve(resumed).then(
          () => finish(context.state === "running"),
          () => finish(false),
        );
      });
    } catch {
      return Promise.resolve(false);
    }
  }
  function playbackError(player, text) {
    player.error.textContent = text;
    player.error.hidden = false;
    player.node.dataset.playbackState = "error";
    player.play.disabled = false;
    player.play.textContent = "Écouter";
    player.play.setAttribute("aria-pressed", "false");
    announce(text);
    if (player === welcome && phase === "welcome") setPhase("name");
    if (player === reply) revealEmail();
  }
  function makePlayer(body, label, load) {
    const node = element("div", "voice-player");
    node.setAttribute("role", "group");
    node.setAttribute("aria-label", label);
    node.dataset.playbackState = "idle";
    const wave = element("span", "voice-wave");
    wave.setAttribute("aria-hidden", "true");
    // No invented waveform: bars remain empty until a decoded buffer exists.
    for (let i = 0; i < 24; i++) {
      const bar = element("span");
      bar.style.setProperty("--bar-height", "0%");
      wave.append(bar);
    }
    const time = element("span", "voice-time", "--:--");
    time.setAttribute("aria-live", "off");
    const error = element("p", "voice-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const player = { node, wave, time, error, load, buffer: null, offset: 0 };
    player.play = button("Écouter", "voice-play", (event) => {
      if (micBusy || !event.isTrusted) return;
      if (playback?.player === player) {
        stopPlayback(true);
        return;
      }
      const unlocked = unlockAudio();
      void playPlayer(player, unlocked);
    });
    player.play.setAttribute("aria-pressed", "false");
    player.play.setAttribute("aria-label", `Lecture audio : ${label}`);
    node.append(player.play, wave, time, error);
    body.append(node);
    return player;
  }
  function setBuffer(player, buffer) {
    player.buffer = buffer;
    const levels = [];
    for (let bar = 0; bar < 24; bar++) {
      const start = Math.floor((bar * buffer.length) / 24);
      const end = Math.floor(((bar + 1) * buffer.length) / 24);
      let square = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        for (let i = start; i < end; i++) square += samples[i] * samples[i];
      }
      levels.push(
        Math.sqrt(
          square / Math.max(1, (end - start) * buffer.numberOfChannels),
        ),
      );
    }
    const peak = Math.max(...levels, 0.000001);
    [...player.wave.children].forEach((bar, i) =>
      bar.style.setProperty("--bar-height", `${(levels[i] / peak) * 100}%`),
    );
    player.node.classList.add("is-ready");
    player.node.dataset.playbackState = "ready";
    player.time.textContent = `00:00 / ${clock(buffer.duration)}`;
  }
  function updateProgress(player, seconds) {
    const duration = player.buffer?.duration || 0;
    const progress = duration ? Math.min(1, seconds / duration) : 0;
    player.node.style.setProperty("--progress", String(progress));
    [...player.wave.children].forEach((bar, i) =>
      bar.classList.toggle("is-played", progress >= (i + 1) / 24),
    );
    const text = `${clock(seconds)} / ${clock(duration)}`;
    if (player.time.textContent !== text) player.time.textContent = text;
  }
  function animateLevel() {
    window.cancelAnimationFrame(frame);
    frame = 0;
    const active = playback || (capture?.active ? capture : null);
    if (!dialog.open || !active?.analyser) return;
    active.analyser.getFloatTimeDomainData(active.meter);
    let square = 0;
    for (const sample of active.meter) square += sample * sample;
    orb?.style.setProperty(
      "--voice-level",
      String(Math.min(1, Math.sqrt(square / active.meter.length) * 4)),
    );
    if (playback) {
      updateProgress(
        playback.player,
        playback.offset + context.currentTime - playback.started,
      );
    } else {
      const seconds = Math.min(
        MAX_RECORDING_SECONDS,
        capture.samples / context.sampleRate,
      );
      if (caption)
        caption.textContent = `Votre prénom · ${seconds.toFixed(1).replace(".", ",")} / ${MAX_RECORDING_SECONDS} s`;
    }
    frame = window.requestAnimationFrame(animateLevel);
  }
  function stopPlayback(paused = false) {
    playIntent++;
    window.cancelAnimationFrame(frame);
    frame = 0;
    if (playback) {
      const current = playback;
      playback = null;
      current.player.offset = Math.min(
        current.player.buffer.duration,
        current.offset + context.currentTime - current.started,
      );
      current.source.onended = null;
      try {
        current.source.stop();
      } catch {
        /* Already ended. */
      }
      current.source.disconnect();
      current.analyser.disconnect();
      current.player.play.textContent = "Écouter";
      current.player.play.setAttribute("aria-pressed", "false");
      current.player.node.dataset.playbackState = paused ? "paused" : "ready";
      updateProgress(current.player, current.player.offset);
      if (paused && current.player === welcome && phase === "welcome")
        setPhase("name");
      if (paused && current.player === reply) revealEmail();
    }
    idleState();
  }
  async function playPlayer(player, unlocked) {
    stopPlayback();
    const ticket = playIntent;
    const currentGeneration = generation;
    player.error.hidden = true;
    player.node.dataset.playbackState = "loading";
    player.play.disabled = true;
    voiceState("loading", "Chargement du message…");
    try {
      const allowed = await unlocked;
      if (
        ticket !== playIntent ||
        currentGeneration !== generation ||
        !dialog.open ||
        !player.node.isConnected
      )
        return;
      if (!allowed || context?.state !== "running") {
        playbackError(
          player,
          "Le son n’a pas démarré. Touchez Écouter, ou lisez le message ci-dessus.",
        );
        return;
      }
      const buffer = await player.load();
      if (!player.buffer) setBuffer(player, buffer);
      if (
        ticket !== playIntent ||
        currentGeneration !== generation ||
        !dialog.open ||
        !player.node.isConnected
      )
        return;
      if (context.state !== "running") {
        playbackError(
          player,
          "Le son a été interrompu. Touchez Écouter pour reprendre.",
        );
        return;
      }
      const source = context.createBufferSource();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.buffer = buffer;
      source.connect(analyser);
      analyser.connect(context.destination);
      const offset =
        player.offset >= buffer.duration - 0.02 ? 0 : player.offset;
      playback = {
        player,
        source,
        analyser,
        meter: new Float32Array(analyser.fftSize),
        offset,
        started: context.currentTime,
      };
      source.onended = () => {
        if (playback?.source !== source) return;
        stopPlayback();
        player.offset = 0;
        updateProgress(player, buffer.duration);
        player.node.dataset.playbackState = "ended";
        if (player === welcome && phase === "welcome") setPhase("name");
        if (player === reply) revealEmail();
      };
      source.start(0, offset);
      player.node.dataset.playbackState = "playing";
      player.play.textContent = "Pause";
      player.play.setAttribute("aria-pressed", "true");
      voiceState("speaking", "Léa vous parle");
      animateLevel();
    } catch (error) {
      if (
        ticket === playIntent &&
        currentGeneration === generation &&
        dialog.open &&
        player.node.isConnected
      ) {
        stopPlayback();
        playbackError(
          player,
          error.name === "Error"
            ? error.message
            : "Le son est indisponible. Le message reste lisible.",
        );
      }
    } finally {
      player.loading?.remove();
      player.play.disabled = micBusy;
      if (player.node.dataset.playbackState === "loading")
        player.node.dataset.playbackState = player.buffer ? "ready" : "idle";
      if (ticket === playIntent && !playback && !micBusy) idleState();
    }
  }
  function loadWelcome() {
    welcomeAudio ||= (async () => {
      if (!context)
        throw new Error(
          "Votre navigateur ne permet pas le son ici. Vous pouvez lire le message.",
        );
      try {
        const response = await fetch(new URL(WELCOME_AUDIO, import.meta.url));
        if (!response.ok) throw new Error("audio");
        return await context.decodeAudioData(await response.arrayBuffer());
      } catch {
        throw new Error(
          "Le message audio est indisponible. Vous pouvez lire le texte.",
        );
      }
    })();
    return welcomeAudio;
  }
  function voiceError(statusCode) {
    if (statusCode === 429)
      return "La voix est très sollicitée. Vous pouvez continuer par écrit.";
    if (statusCode === 409)
      return "Ce message a déjà été demandé. Vous pouvez continuer par écrit.";
    return "La voix est indisponible pour le moment. Vous pouvez continuer par écrit.";
  }
  function loadGreeting(value) {
    if (greetings.has(value)) return greetings.get(value);
    // Keep failures too: revisiting a name never silently buys another generation.
    if (greetings.size >= 8)
      return Promise.reject(
        new Error(
          "Vous avez essayé plusieurs prénoms. Vous pouvez continuer par écrit.",
        ),
      );
    const pending = (async () => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 25000);
      let failure =
        "Le message audio n’a pas pu être chargé. Vous pouvez continuer par écrit, sans nouvel envoi automatique.";
      try {
        const response = await fetch("/api/voice?action=greet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: value,
            requestId: crypto.randomUUID(),
            website: "",
          }),
          signal: controller.signal,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
        });
        if (
          response.status !== 200 ||
          !response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("audio/mpeg")
        ) {
          failure = voiceError(response.status);
          throw new Error(failure);
        }
        const bytes = await response.arrayBuffer();
        if (!context) {
          failure =
            "Votre navigateur ne permet pas le son ici. Le message reste lisible.";
          throw new Error(failure);
        }
        return await context.decodeAudioData(bytes);
      } catch {
        throw new Error(failure);
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    greetings.set(value, pending);
    return pending;
  }

  function honeypot() {
    const input = element("input", "voice-honeypot");
    input.type = "text";
    input.name = "website";
    input.autocomplete = "off";
    input.tabIndex = -1;
    input.hidden = true;
    input.setAttribute("aria-hidden", "true");
    return input;
  }
  function formError(form, text, invalid = false) {
    form.error.textContent = text;
    form.error.hidden = !text;
    if (invalid) form.input.setAttribute("aria-invalid", "true");
    else form.input.removeAttribute("aria-invalid");
    if (text) announce(text);
  }
  function fields(kind) {
    const form = element(
      "form",
      kind === "name" ? "voice-composer-form" : "voice-email-form",
    );
    form.noValidate = true;
    const input = element("input");
    input.id = `chat-${kind}`;
    input.name = kind;
    input.type = kind === "email" ? "email" : "text";
    input.placeholder =
      kind === "email" ? "vous@entreprise.fr" : "Votre prénom…";
    input.autocomplete = kind === "email" ? "email" : "given-name";
    input.maxLength = kind === "email" ? 254 : 60;
    input.enterKeyHint = "send";
    input.required = true;
    const label = element(
      "label",
      "sr-only",
      kind === "email" ? "Votre e-mail" : "Votre prénom",
    );
    label.htmlFor = input.id;
    const submit = element(
      "button",
      kind === "email" ? "voice-email-submit" : "voice-send",
      kind === "email" ? "Recevoir" : "→",
    );
    submit.type = "submit";
    if (kind === "name")
      submit.setAttribute("aria-label", "Envoyer mon prénom");
    const error = element("p", "voice-error");
    error.id = `chat-${kind}-error`;
    error.setAttribute("role", "alert");
    error.hidden = true;
    const help = element("p", "voice-input-help");
    help.id = `chat-${kind}-help`;
    input.setAttribute("aria-describedby", `${help.id} ${error.id}`);
    const trap = honeypot();
    form.append(label, input, trap, submit);
    const result = { form, input, submit, error, help, trap, composing: false };
    input.addEventListener("input", () => formError(result, ""));
    input.addEventListener("compositionstart", () => {
      result.composing = true;
    });
    input.addEventListener("compositionend", () => {
      result.composing = false;
    });
    form.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        (event.isComposing || result.composing || event.keyCode === 229)
      )
        event.preventDefault();
    });
    return result;
  }
  function makeNameForm() {
    nameForm = fields("name");
    const current = nameForm;
    current.help.textContent = "Votre prénom uniquement · 6 secondes maximum.";
    current.mic = button("Micro", "voice-mic", (event) => {
      if (!event.isTrusted) return;
      if (capture?.active) void finishRecording(capture);
      else if (!micBusy) void startRecording();
    });
    current.mic.setAttribute("aria-label", "Dire mon prénom au micro");
    current.mic.disabled = micUnavailable;
    current.cancel = button("Annuler", "voice-cancel-recording", () =>
      cancelMicrophone(),
    );
    current.cancel.hidden = true;
    const entry = element("div", "voice-compose-entry");
    entry.append(current.input, current.mic, current.submit);
    current.form.append(entry, current.cancel, current.help, current.error);
    current.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (
        current.composing ||
        micBusy ||
        sending ||
        !current.form.isConnected ||
        !["name", "welcome"].includes(phase)
      )
        return;
      const value = normalizeName(current.input.value);
      if (!value || current.trap.value) {
        formError(
          current,
          "Indiquez votre prénom avec des lettres, des espaces, des tirets ou des apostrophes (60 caractères maximum).",
          true,
        );
        current.input.focus({ preventScroll: true });
        return;
      }
      const unlocked = event.isTrusted ? unlockAudio() : Promise.resolve(false);
      submitName(value, unlocked);
    });
    composer.hidden = false;
    composer.replaceChildren(current.form);
  }
  function submitName(value, unlocked) {
    cancelMicrophone();
    stopPlayback();
    reading = false;
    generation++;
    name = value;
    setPhase("responding");
    composer.hidden = true;
    if (!history) {
      history = element("details", "voice-history");
      history.append(
        element("summary", "", "Le message d’accueil"),
        welcome.article,
      );
      log.prepend(history);
    }
    userMessage = message("user", name);
    editName = button("Modifier", "voice-edit-name", changeName);
    editName.setAttribute("aria-label", "Modifier mon prénom");
    editName.addEventListener("focus", () => {
      if (!sending && !accepted) {
        stopPlayback();
        revealEmail();
      }
    });
    userMessage.body.append(editName);
    const assistant = message("lea", personalizedReply(name));
    assistant.article.classList.add("voice-personalized");
    const transcript = presentMessage(
      assistant,
      "Enchantée,",
      `${name}.`,
      "Je vous envoie une courte présentation de Ruchée ?",
      personalizedReply(name),
    );
    const player = makePlayer(
      assistant.body,
      `Message de Léa pour ${name}`,
      () => loadGreeting(value),
    );
    player.article = assistant.article;
    assistant.body.append(transcript);
    reply = player;
    const loading = element(
      "p",
      "voice-reply-status",
      "Léa prépare son message…",
    );
    player.loading = loading;
    assistant.body.append(loading);
    continueButton = button("Continuer sans le son", "voice-continue", () => {
      stopPlayback();
      revealEmail();
    });
    assistant.body.append(continueButton);
    void playPlayer(player, unlocked);
    if (dialog.open) {
      log.scrollTop = log.scrollHeight;
      close.focus({ preventScroll: true });
    }
  }
  function changeName() {
    if (sending || accepted) return;
    generation++;
    stopPlayback();
    cancelMicrophone();
    userMessage?.article.remove();
    reply?.article.remove();
    emailCard?.remove();
    emailCard = null;
    reply = null;
    continueButton = null;
    const previous = name;
    name = "";
    if (history) {
      history.replaceWith(welcome.article);
      history = null;
    }
    setPhase("name");
    makeNameForm();
    nameForm.input.value = previous;
    if (dialog.open) nameForm.input.focus({ preventScroll: true });
  }
  function lockName() {
    reset.disabled = sending;
    if (editName) editName.disabled = sending || accepted;
  }
  function revealEmail() {
    if (!name || emailCard || phase === "done") return;
    setPhase("email");
    if (continueButton) continueButton.hidden = true;
    const card = element("article", "voice-email-card");
    emailCard = card;
    card.append(
      element("h3", "", "Je vous l’envoie ?"),
      element("p", "", "Une courte présentation de Ruchée."),
    );
    const email = fields("email");
    email.help.className = "voice-email-privacy";
    email.help.textContent = "Un seul e-mail. Pas de newsletter. ";
    const privacy = element("a", "", "Confidentialité");
    privacy.href = "confidentialite.html";
    privacy.target = "_blank";
    privacy.rel = "noopener";
    privacy.setAttribute("aria-label", "Confidentialité (nouvel onglet)");
    email.help.append(privacy);
    const skip = button("Pas maintenant", "voice-skip", () => {
      if (sending || accepted || phase !== "email") return;
      stopPlayback();
      completeCard(
        `Pas de souci, ${name}. Vous pouvez revenir quand vous voulez.`,
      );
    });
    email.form.append(email.help, email.error, skip);
    email.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!email.composing && email.form.isConnected)
        void sendRecap(email, skip);
    });
    card.append(email.form);
    updateLog(() => log.append(card));
    announce("Vous pouvez recevoir la présentation par e-mail.");
  }
  function completeCard(text) {
    const hadFocus = emailCard?.contains(document.activeElement);
    updateLog(() => {
      emailCard.classList.add("is-complete");
      emailCard.replaceChildren(element("p", "", text));
    });
    setPhase("done");
    announce(text);
    if (hadFocus && dialog.open) close.focus({ preventScroll: true });
  }
  function recapError(result) {
    switch (result?.code) {
      case "invalid":
        return "Vérifiez votre prénom et votre adresse e-mail.";
      case "limited":
        return "La limite d’envoi est atteinte. Réessayez plus tard.";
      case "pending":
        return "Cette demande est déjà en cours. L’envoi n’est pas encore confirmé.";
      case "uncertain":
        return "L’envoi n’est pas confirmé. Aucun nouvel envoi ne sera lancé automatiquement.";
      default:
        return "L’envoi est indisponible pour le moment.";
    }
  }
  async function sendRecap(email, skip) {
    if (sending || accepted || phase !== "email") return;
    const address = email.input.value.trim().toLowerCase();
    email.input.value = address;
    formError(email, "");
    if (
      !address ||
      address.length > 254 ||
      /[\s\p{Cc}]/u.test(address) ||
      email.input.validity.typeMismatch
    ) {
      formError(
        email,
        "Indiquez une adresse e-mail valide (254 caractères maximum).",
        true,
      );
      return;
    }
    if (
      !window.crypto?.randomUUID ||
      typeof fetch !== "function" ||
      typeof AbortController !== "function"
    ) {
      formError(email, recapError());
      return;
    }
    const payload = { name, email: address, website: email.trap.value };
    const key = JSON.stringify(payload);
    if (!recapRequests.has(key))
      recapRequests.set(key, { ...payload, requestId: crypto.randomUUID() });
    const request = recapRequests.get(key);
    sending = true;
    lockName();
    email.input.disabled = email.submit.disabled = skip.disabled = true;
    email.form.setAttribute("aria-busy", "true");
    email.form.classList.add("is-loading");
    email.submit.textContent = "Envoi…";
    announce(
      "Envoi en cours. Vous pouvez fermer cette fenêtre sans interrompre la demande.",
    );
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch("/api/recap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      });
      const result = await response.json();
      if (response.ok && result?.ok === true && result.code === "sent") {
        accepted = true;
        stopPlayback();
        completeCard("La présentation est en route.");
        message("lea", `À bientôt, ${name}.`);
      } else {
        // Unknown/pending responses retain the same id, including across reset.
        if (
          result?.ok === false &&
          result.code === "unavailable" &&
          result.retryable === true
        )
          recapRequests.delete(key);
        formError(email, recapError(result));
      }
    } catch {
      formError(email, recapError({ code: "uncertain" }));
    } finally {
      window.clearTimeout(timeout);
      sending = false;
      lockName();
      email.input.disabled = email.submit.disabled = skip.disabled = false;
      email.form.removeAttribute("aria-busy");
      email.form.classList.remove("is-loading");
      email.submit.textContent = "Recevoir";
    }
  }

  function setMicBusy(busy, listening = false) {
    micBusy = busy;
    if (!nameForm) return;
    nameForm.input.disabled = nameForm.submit.disabled = busy;
    nameForm.mic.disabled = micUnavailable || (busy && !listening);
    nameForm.mic.textContent = listening ? "Arrêter" : "Micro";
    nameForm.mic.setAttribute(
      "aria-label",
      listening ? "Arrêter l’enregistrement" : "Dire mon prénom au micro",
    );
    nameForm.cancel.hidden = !busy;
    nameForm.form.setAttribute("aria-busy", String(busy));
    if (welcome) welcome.play.disabled = busy;
  }
  function releaseCapture(current) {
    if (current.released) return;
    current.released = true;
    window.clearTimeout(current.timer);
    current.active = false;
    current.stream.getTracks().forEach((track) => track.stop());
    if (current.node) {
      current.node.onprocessorerror = null;
      current.node.port.onmessage = null;
      current.node.port.postMessage({ type: "cancel" });
      current.node.port.close();
      current.node.disconnect();
    }
    current.input?.disconnect();
    current.analyser?.disconnect();
    current.mute?.disconnect();
    if (capture === current) {
      window.cancelAnimationFrame(frame);
      frame = 0;
      capture = null;
    }
  }
  function wipeChunks(current) {
    for (const chunk of current.chunks) chunk.fill(0);
    current.chunks.length = 0;
  }
  function cancelMicrophone() {
    micGeneration++;
    if (capture) {
      const current = capture;
      current.flush?.();
      releaseCapture(current);
      wipeChunks(current);
    }
    transcription?.abort();
    transcription = null;
    setMicBusy(false);
    if (!playback) idleState();
  }
  async function startRecording() {
    if (
      micBusy ||
      micUnavailable ||
      !dialog.open ||
      !["welcome", "name"].includes(phase)
    )
      return;
    stopPlayback();
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
      micUnavailable = true;
      setMicBusy(false);
      formError(
        nameForm,
        "Le micro n’est pas disponible dans ce navigateur. Écrivez votre prénom.",
      );
      return;
    }
    const unlocked = unlockAudio();
    const ticket = ++micGeneration;
    const form = nameForm;
    formError(form, "");
    form.help.textContent = "Votre prénom uniquement · 6 secondes maximum.";
    setMicBusy(true);
    voiceState("loading", "Autorisez le micro pour dire votre prénom");
    const setupTimer = window.setTimeout(() => {
      if (ticket !== micGeneration) return;
      cancelMicrophone();
      formError(
        form,
        "Le micro ne répond pas. Écrivez votre prénom ou réessayez.",
      );
    }, 10000);
    let current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      if (ticket !== micGeneration || !dialog.open) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      current = {
        stream,
        chunks: [],
        samples: 0,
        active: false,
        stopping: false,
        ticket,
      };
      capture = current;
      if (!(await unlocked) || !context?.audioWorklet) throw new Error("audio");
      if (ticket !== micGeneration || !dialog.open) return;
      workletReady ||= context.audioWorklet.addModule(
        new URL("./voice-recorder.worklet.js", import.meta.url),
      );
      await workletReady;
      if (ticket !== micGeneration || !dialog.open) return;
      if (context.state !== "running") throw new Error("audio");
      current.input = context.createMediaStreamSource(stream);
      current.node = new AudioWorkletNode(context, "voice-recorder", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { maxSeconds: MAX_RECORDING_SECONDS },
      });
      current.analyser = context.createAnalyser();
      current.analyser.fftSize = 256;
      current.meter = new Float32Array(current.analyser.fftSize);
      current.mute = context.createGain();
      current.mute.gain.value = 0;
      current.node.port.onmessage = ({ data }) => {
        if (ticket !== micGeneration || capture !== current) {
          data.samples?.fill(0);
          return;
        }
        if (data.type === "samples" && data.samples instanceof Float32Array) {
          const remaining =
            Math.floor(context.sampleRate * MAX_RECORDING_SECONDS) -
            current.samples;
          const chunk = data.samples.slice(0, Math.max(0, remaining));
          data.samples.fill(0);
          current.chunks.push(chunk);
          current.samples += chunk.length;
        } else if (data.type === "done") {
          if (current.stopping) current.flush?.();
          else void finishRecording(current, true);
        }
      };
      current.node.onprocessorerror = () => {
        if (ticket !== micGeneration) return;
        cancelMicrophone();
        formError(
          form,
          "L’enregistrement a été interrompu. Écrivez votre prénom.",
        );
      };
      current.input.connect(current.analyser);
      current.analyser.connect(current.node);
      current.node.connect(current.mute);
      current.mute.connect(context.destination);
      current.active = true;
      window.clearTimeout(setupTimer);
      current.timer = window.setTimeout(
        () => void finishRecording(current),
        MAX_RECORDING_SECONDS * 1000,
      );
      setMicBusy(true, true);
      voiceState("listening", "Je vous écoute");
      announce("Micro ouvert. Dites votre prénom, puis touchez Arrêter.");
      animateLevel();
    } catch (error) {
      if (ticket === micGeneration) {
        if (
          ["NotAllowedError", "SecurityError"].includes(error.name) ||
          !current?.active
        )
          micUnavailable = true;
        cancelMicrophone();
        formError(
          form,
          "Le micro n’a pas pu démarrer. Vous pouvez écrire votre prénom.",
        );
      }
    } finally {
      window.clearTimeout(setupTimer);
      if (current && !current.active) {
        releaseCapture(current);
        wipeChunks(current);
      }
    }
  }
  function pcmWav(current) {
    const rate = context.sampleRate;
    if (current.samples < rate * 0.2)
      throw new Error(
        "Dites votre prénom pendant au moins une seconde, ou écrivez-le.",
      );
    const samples = new Float32Array(current.samples);
    let offset = 0;
    for (const chunk of current.chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    wipeChunks(current);
    try {
      let square = 0;
      for (const sample of samples) square += sample * sample;
      if (
        !Number.isFinite(square) ||
        Math.sqrt(square / samples.length) < 0.003
      )
        throw new Error(
          "Je n’ai pas entendu de prénom. Réessayez ou écrivez-le.",
        );
      const count = Math.min(
        96000,
        Math.floor((samples.length * 16000) / rate),
      );
      const wav = new ArrayBuffer(44 + count * 2);
      const view = new DataView(wav);
      const ascii = (at, text) => {
        for (let i = 0; i < text.length; i++)
          view.setUint8(at + i, text.charCodeAt(i));
      };
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
      // Windowed-sinc low-pass resampling avoids aliasing at 44.1/48 kHz.
      const ratio = rate / 16000;
      const cutoff = Math.min(1, 16000 / rate) * 0.9;
      const radius = Math.ceil(16 / cutoff);
      for (let i = 0; i < count; i++) {
        const position = i * ratio;
        let value = 0;
        let weight = 0;
        for (
          let j = Math.max(0, Math.ceil(position - radius));
          j <= Math.min(samples.length - 1, Math.floor(position + radius));
          j++
        ) {
          const distance = j - position;
          const x = Math.PI * distance * cutoff;
          const kernel =
            (Math.abs(x) < 1e-8 ? 1 : Math.sin(x) / x) *
            (0.5 + 0.5 * Math.cos((Math.PI * distance) / radius));
          value += samples[j] * kernel;
          weight += kernel;
        }
        const sample = Math.max(-1, Math.min(1, weight ? value / weight : 0));
        view.setInt16(
          44 + i * 2,
          Math.round(sample * (sample < 0 ? 32768 : 32767)),
          true,
        );
      }
      return wav;
    } finally {
      samples.fill(0);
    }
  }
  async function finishRecording(current, alreadyFlushed = false) {
    if (capture !== current || current.stopping || !current.active) return;
    current.stopping = true;
    current.active = false;
    window.clearTimeout(current.timer);
    current.stream.getTracks().forEach((track) => track.stop());
    window.cancelAnimationFrame(frame);
    frame = 0;
    setMicBusy(true);
    voiceState("loading", "Reconnaissance du prénom…");
    if (!alreadyFlushed) {
      await new Promise((resolve) => {
        const timeout = window.setTimeout(resolve, 150);
        current.flush = () => {
          window.clearTimeout(timeout);
          resolve();
        };
        current.node.port.postMessage({ type: "stop" });
      });
    }
    const form = nameForm;
    const ticket = current.ticket;
    releaseCapture(current);
    let wav;
    let timeout;
    try {
      if (ticket !== micGeneration || !dialog.open) return;
      wav = pcmWav(current);
      const controller = new AbortController();
      transcription = controller;
      timeout = window.setTimeout(() => controller.abort(), 25000);
      const response = await fetch("/api/voice?action=transcribe", {
        method: "POST",
        headers: {
          "Content-Type": "audio/wav",
          "X-Voice-Request-Id": crypto.randomUUID(),
          "X-Voice-Website": form.trap.value,
        },
        body: wav,
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) throw new Error(voiceError(response.status));
      const result = await response.json();
      if (ticket !== micGeneration || !dialog.open) return;
      const value = result?.ok === true ? normalizeName(result.name) : null;
      if (!value)
        throw new Error(
          "Je n’ai pas reconnu votre prénom. Vous pouvez l’écrire.",
        );
      form.input.value = value;
      form.help.textContent =
        "Prénom reconnu. Vous pouvez le corriger, puis l’envoyer.";
      announce(form.help.textContent);
    } catch (error) {
      if (ticket === micGeneration && dialog.open)
        formError(
          form,
          error.name === "AbortError" ||
            error instanceof TypeError ||
            error instanceof SyntaxError
            ? "La reconnaissance n’a pas abouti. Écrivez votre prénom ou réessayez."
            : error.message,
        );
    } finally {
      window.clearTimeout(timeout);
      if (wav) new Uint8Array(wav).fill(0);
      wipeChunks(current);
      if (ticket === micGeneration) {
        transcription = null;
        setMicBusy(false);
        idleState();
        if (dialog.open) form.input.focus({ preventScroll: true });
      }
    }
  }

  function start() {
    setPhase("welcome");
    const assistant = message("lea", WELCOME_TEXT);
    assistant.article.classList.add("voice-welcome");
    const transcript = presentMessage(
      assistant,
      "Bonjour,",
      "moi c’est Léa.",
      "Comment vous appelez-vous ?",
      WELCOME_TEXT,
    );
    welcome = makePlayer(
      assistant.body,
      "Message d’accueil de Léa",
      loadWelcome,
    );
    welcome.article = assistant.article;
    assistant.body.append(transcript);
    makeNameForm();
    voiceState("idle", "Un message pour vous");
  }
  function resizeViewport() {
    if (!dialog.open) return;
    const follow = !reading && nearBottom();
    dialog.dataset.compactHeight = String(
      (viewport?.height ?? window.innerHeight) < 520,
    );
    dialog.style.setProperty(
      "--chat-viewport-height",
      `${viewport?.height ?? window.innerHeight}px`,
    );
    dialog.style.setProperty(
      "--chat-viewport-top",
      `${viewport?.offsetTop ?? 0}px`,
    );
    if (follow) log.scrollTop = log.scrollHeight;
  }
  function visibility(open) {
    window.dispatchEvent(
      new CustomEvent("lea-chat-visibility", { detail: { open } }),
    );
  }
  function openDialog(source = document.activeElement, trusted = false) {
    if (dialog.open) return true;
    // Resume synchronously in the CTA click; hash opens never fetch or play audio.
    const unlocked = trusted ? unlockAudio() : Promise.resolve(false);
    invoker = source;
    try {
      dialog.showModal();
    } catch {
      fallback.hidden = false;
      void context?.suspend().catch(() => {});
      return false;
    }
    sessionOpen = true;
    previousOverflow = document.body.style.getPropertyValue("overflow");
    previousOverflowPriority =
      document.body.style.getPropertyPriority("overflow");
    document.body.style.setProperty("overflow", "hidden");
    if (!welcome) start();
    resizeViewport();
    viewport?.addEventListener("resize", resizeViewport);
    viewport?.addEventListener("scroll", resizeViewport);
    window.addEventListener("resize", resizeViewport);
    visibility(true);
    if (!reading) log.scrollTop = log.scrollHeight;
    // Avoid opening the mobile keyboard before the visitor chooses to type.
    close.focus({ preventScroll: true });
    if (!everOpened && trusted) void playPlayer(welcome, unlocked);
    else if (phase === "welcome") setPhase("name");
    everOpened = true;
    return true;
  }
  function cleanupClose() {
    if (!sessionOpen || dialog.open) return;
    sessionOpen = false;
    orbTransition?.cancel();
    generation++;
    stopPlayback();
    cancelMicrophone();
    if (phase === "responding") revealEmail();
    void context?.suspend().catch(() => {});
    viewport?.removeEventListener("resize", resizeViewport);
    viewport?.removeEventListener("scroll", resizeViewport);
    window.removeEventListener("resize", resizeViewport);
    dialog.style.removeProperty("--chat-viewport-height");
    dialog.style.removeProperty("--chat-viewport-top");
    if (previousOverflow)
      document.body.style.setProperty(
        "overflow",
        previousOverflow,
        previousOverflowPriority,
      );
    else document.body.style.removeProperty("overflow");
    if (window.location.hash === "#parler-a-lea") {
      try {
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${window.location.search}`,
        );
      } catch {
        /* Closing and focus restoration still work in restricted embeds. */
      }
    }
    visibility(false);
    if (invoker?.isConnected && typeof invoker.focus === "function")
      invoker.focus({ preventScroll: true });
  }
  function closeDialog() {
    if (dialog.open) dialog.close();
    cleanupClose();
  }
  close.addEventListener("click", closeDialog);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });
  dialog.addEventListener("close", cleanupClose);
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const controls = [
      ...dialog.querySelectorAll(
        'button:not(:disabled), a[href], summary, input:not(:disabled):not([tabindex="-1"]), [tabindex="0"]',
      ),
    ].filter(
      (node) =>
        node.getClientRects().length && !node.closest("[hidden], [inert]"),
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (!first) {
      event.preventDefault();
      dialog.focus();
    } else if (
      event.shiftKey &&
      (document.activeElement === first ||
        !controls.includes(document.activeElement))
    ) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (
      !event.shiftKey &&
      (document.activeElement === last ||
        !controls.includes(document.activeElement))
    ) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  });
  reset.addEventListener("click", () => {
    if (sending) return;
    generation++;
    stopPlayback();
    cancelMicrophone();
    accepted = false;
    name = "";
    reply = emailCard = userMessage = editName = continueButton = null;
    history = null;
    reading = false;
    log.replaceChildren();
    announce("");
    start();
    setPhase("name");
    nameForm.input.focus({ preventScroll: true });
  });
  log.addEventListener(
    "scroll",
    () => {
      reading = !nearBottom();
    },
    { passive: true },
  );
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) orbTransition?.cancel();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden || !dialog.open) return;
    stopPlayback(true);
    cancelMicrophone();
    void context?.suspend().catch(() => {});
  });
  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const anchor =
      event.target instanceof Element
        ? event.target.closest("a[data-lea-open]")
        : null;
    if (
      !anchor ||
      anchor.hasAttribute("download") ||
      (anchor.target && anchor.target !== "_self")
    )
      return;
    const url = new URL(anchor.href, window.location.href);
    if (
      url.origin !== window.location.origin ||
      url.pathname !== window.location.pathname ||
      url.search !== window.location.search ||
      url.hash !== "#parler-a-lea"
    )
      return;
    if (openDialog(anchor, event.isTrusted)) event.preventDefault();
  });
  window.addEventListener("hashchange", () => {
    if (window.location.hash === "#parler-a-lea") openDialog();
  });
  reset.disabled = false;
  fallback.hidden = true;
  if (window.location.hash === "#parler-a-lea") openDialog();
}

void initialize().catch(() => {
  const fallback = document.querySelector("#parler-a-lea[data-chat-fallback]");
  if (fallback) fallback.hidden = false;
});
