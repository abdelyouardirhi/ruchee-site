// Fixed wording for « Parler à Léa ». The server builds every spoken sentence from
// these functions: a visitor can never make Léa say an arbitrary text.

// Intro video (Léa on camera, 10 s). The transcript is shown as captions.
export const INTRO_VIDEO = "video/lea-intro.mp4";
export const INTRO_POSTER = "video/lea-intro-poster.jpg";
export const INTRO_CAPTIONS = [
  { start: 0.9, end: 3.9, text: "Bonjour, je suis Léa, l’assistante de Ruchée." },
  { start: 4.1, end: 6.6, text: "Je suis à votre écoute pour vous aider." },
];
// The last seconds are a silent smile: the chat starts here.
export const INTRO_HANDOFF_SECONDS = 7;
// Where Léa's face sits in the video frame (fractions of width / height).
export const INTRO_FACE = { x: 0.297, y: 0.3, radius: 0.2 };

// Léa's voice notes are fixed recordings (scripts/generate-voice.mjs): nothing
// the visitor types is ever spoken, and no voice service runs on the site.
export const TTS_MODEL = "voxtral-mini-tts-3-0";
export const VOICE_ID = "01a1ad29-4e34-76ed-96b7-2ac31605240d"; // « Léa (vidéo) », cloned from the intro video
export const VOICE_EXPRESSIVENESS = 3;

// First voice note in the chat.
export const QUESTION = {
  text: "Dites-moi : qu’est-ce qui vous complique le plus les journées ?",
  audio: "audio/lea-question-v1.mp3",
  seconds: 3,
};

const CLOSING = "Laissez-moi vos coordonnées : nous vous rappelons pour en parler.";

// The visitor picks one answer; Léa replies with the matching voice note.
export const PAINS = [
  {
    id: "absences",
    glyph: "!",
    label: "Les absences de dernière minute",
    detail: "Un appel à 5h, un site à couvrir",
    reply: `Ah, je vois. Avec moi à vos côtés, une absence à 5h du matin, je m’en occupe : je propose le créneau à votre équipe sur WhatsApp, et vous êtes prévenu dès que le site est couvert. ${CLOSING}`,
    audio: "audio/lea-absences-v1.mp3",
    seconds: 15,
  },
  {
    id: "recrutement",
    glyph: "+",
    label: "Recruter, encore et encore",
    detail: "Des candidats qui ne répondent plus",
    reply: `Ah, je vois. Avec moi à vos côtés, chaque candidat reçoit une réponse en moins d’une minute. Je réunis ses réponses à vos critères, et c’est vous qui décidez qui rencontrer. ${CLOSING}`,
    audio: "audio/lea-recrutement-v1.mp3",
    seconds: 14,
  },
  {
    id: "telephone",
    glyph: "↗",
    label: "Le téléphone qui sonne sans arrêt",
    detail: "Horaires, adresses, retards",
    reply: `Ah, je vois. Avec moi à vos côtés, je réponds à votre équipe à toute heure, dans sa langue : horaires, adresses, retards. Et je ne vous dérange que pour ce qui compte. ${CLOSING}`,
    audio: "audio/lea-telephone-v1.mp3",
    seconds: 15,
  },
  {
    id: "sites",
    glyph: "✓",
    label: "Savoir si chaque site est couvert",
    detail: "Qui est arrivé, où, à quelle heure",
    reply: `Ah, je vois. Avec moi à vos côtés, vous recevez chaque matin le point de 8h : qui est arrivé, et quels sites restent à couvrir. Vous commencez la journée sans surprise. ${CLOSING}`,
    audio: "audio/lea-sites-v1.mp3",
    seconds: 16,
  },
  {
    id: "tout",
    glyph: "★",
    label: "Tout à la fois",
    detail: "Absences, recrutement, appels, suivi",
    reply: `Ah, je vois : tout à la fois. Avec moi à vos côtés, je gère les absences, je réponds aux candidats et à votre équipe, et chaque matin, je vous fais le point de 8h. Vous gardez les décisions, je prends les messages. ${CLOSING}`,
    audio: "audio/lea-tout-v1.mp3",
    seconds: 17,
  },
];

export function painById(id) {
  return PAINS.find((pain) => pain.id === id) ?? null;
}

// Every fixed recording, for the generator.
export const VOICE_CLIPS = [
  QUESTION,
  ...PAINS.map((pain) => ({ text: pain.reply, audio: pain.audio })),
];

export function normalizeName(value) {
  if (typeof value !== "string" || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const name = value.trim().normalize("NFC");
  if (
    [...name].length < 1 ||
    [...name].length > 60 ||
    !/^[\p{L}\p{M} '’‐‑-]+$/u.test(name) ||
    !/\p{L}/u.test(name)
  )
    return null;
  return name;
}

// French numbers (0X XX XX XX XX, +33, 0033) or any international +number.
// Returns E.164 (+33612345678) or null.
export function normalizePhone(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const compact = value.trim().replace(/[\s.\-() ]/gu, "");
  let digits;
  if (/^0[1-9]\d{8}$/u.test(compact)) digits = `33${compact.slice(1)}`;
  else if (/^\+33[1-9]\d{8}$/u.test(compact)) digits = compact.slice(1);
  else if (/^0033[1-9]\d{8}$/u.test(compact)) digits = compact.slice(2);
  else if (/^\+[1-9]\d{7,14}$/u.test(compact)) digits = compact.slice(1);
  else if (/^00[1-9]\d{7,14}$/u.test(compact)) digits = compact.slice(2);
  else return null;
  return `+${digits}`;
}

// +33612345678 → 06 12 34 56 78 ; other countries stay in E.164.
export function displayPhone(e164) {
  const french = /^\+33(\d{9})$/u.exec(e164);
  if (!french) return e164;
  return `0${french[1]}`.replace(/(\d{2})(?=\d)/gu, "$1 ");
}

// The two e-mails sent when a visitor asks to be called back.
export function callbackEmails({ name, phone, email, topic }) {
  const shown = displayPhone(phone);
  const pain = painById(topic);
  return {
    visitor: {
      subject: `${name}, nous vous rappelons`,
      text: [
        `Bonjour ${name},`,
        "Merci pour votre échange avec Léa, l’assistante virtuelle de Ruchée.",
        `Nous avons bien noté votre numéro : ${shown}. Une personne de l’équipe Ruchée vous rappelle pour parler de ce qui vous complique les journées${pain ? ` (« ${pain.label.toLowerCase()} »)` : ""} et voir avec vous comment Léa peut aider votre entreprise.`,
        "En attendant, une question ? Répondez simplement à cet e-mail.",
        "L’équipe Ruchée\nhttps://ruchee.fr",
        "Cet e-mail vous est envoyé une seule fois, à votre demande. Vous n’êtes inscrit à aucune newsletter.",
      ].join("\n\n"),
    },
    team: {
      subject: `À rappeler : ${name} · ${shown}`,
      text: [
        "Nouveau contact depuis « Parler à Léa » sur ruchee.fr.",
        `Prénom : ${name}\nTéléphone : ${shown}\nE-mail : ${email}\nCe qui lui complique les journées : ${pain ? pain.label : "non indiqué"}`,
        "Répondre à cet e-mail écrit directement à ce contact.",
      ].join("\n\n"),
    },
  };
}
