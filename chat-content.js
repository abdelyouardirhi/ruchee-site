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

// First voice note in the chat (static file, generated once).
export const WELCOME_TEXT = "Et vous, comment vous appelez-vous ?";
export const WELCOME_AUDIO = "audio/lea-prenom-v2.mp3";

export const TTS_MODEL = "voxtral-mini-tts-3-0";
export const TRANSCRIBE_MODEL = "voxtral-mini-transcribe-3-0";
export const VOICE_ID = "01a1ad29-4e34-76ed-96b7-2ac31605240d"; // « Léa (vidéo) », cloned from the intro video
export const VOICE_EXPRESSIVENESS = 3;
export const MAX_RECORDING_SECONDS = 6;

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

// Spoken by Léa with the visitor's confirmed first name (≤ 240 characters).
export function personalizedReply(name) {
  return `Bonjour ${name}, ravie de faire votre connaissance. Laissez-moi votre numéro : nous restons en contact et nous vous rappelons.`;
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
export function callbackEmails({ name, phone, email }) {
  const shown = displayPhone(phone);
  return {
    visitor: {
      subject: `${name}, nous vous rappelons`,
      text: [
        `Bonjour ${name},`,
        "Merci pour votre échange avec Léa, l’assistante virtuelle de Ruchée.",
        `Nous avons bien noté votre numéro : ${shown}. Une personne de l’équipe Ruchée vous rappelle pour vous présenter Léa et voir avec vous comment elle peut aider votre entreprise.`,
        "En attendant, une question ? Répondez simplement à cet e-mail.",
        "L’équipe Ruchée\nhttps://ruchee.fr",
        "Cet e-mail vous est envoyé une seule fois, à votre demande. Vous n’êtes inscrit à aucune newsletter.",
      ].join("\n\n"),
    },
    team: {
      subject: `À rappeler : ${name} · ${shown}`,
      text: [
        "Nouveau contact depuis « Parler à Léa » sur ruchee.fr.",
        `Prénom : ${name}\nTéléphone : ${shown}\nE-mail : ${email}`,
        "Répondre à cet e-mail écrit directement à ce contact.",
      ].join("\n\n"),
    },
  };
}
