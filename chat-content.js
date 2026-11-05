export const WELCOME_TEXT =
  "Bonjour, je suis Léa, l’assistante virtuelle de Ruchée. Et vous, comment vous appelez-vous ?";
export const WELCOME_AUDIO = "audio/lea-accueil-v1.mp3";
export const TTS_MODEL = "voxtral-mini-tts-3-0";
export const TRANSCRIBE_MODEL = "voxtral-mini-transcribe-3-0";
export const VOICE_ID = "01a151d2-8c33-7781-a14d-bd91dd8426cc";
export const VOICE_EXPRESSIVENESS = 3;
export const MAX_RECORDING_SECONDS = 6;

export function normalizeName(value) {
  if (typeof value !== "string" || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const name = value.trim().normalize("NFC");
  if (
    [...name].length < 1 ||
    [...name].length > 60 ||
    !/^[\p{L}\p{M} '\u2019\u2010\u2011-]+$/u.test(name) ||
    !/\p{L}/u.test(name)
  )
    return null;
  return name;
}

export function personalizedReply(name) {
  return `Enchantée, ${name}. Je peux vous envoyer une courte présentation de Ruchée. Vous souhaitez la recevoir par e-mail ?`;
}

export const PRESENTATION = {
  title: "Léa, le bras droit de votre entreprise de nettoyage",
  intro:
    "Ruchée aide les entreprises de nettoyage qui interviennent chez les particuliers et dans les locaux professionnels.",
  points: [
    "Recrutement : Léa recueille les réponses aux questions du poste. Vous choisissez qui rencontrer, sans note attribuée par l’IA ni rejet automatique.",
    "Remplacements : Léa propose le créneau aux salariés disponibles. Si personne n’accepte, le patron est prévenu. Aucun remplacement n’est garanti.",
    "Suivi : le point de 8h réunit les pointages, les retards signalés et les prestations à couvrir. Les arrivées viennent du QR code, sans suivi GPS.",
    "Consignes : Léa prépare les messages et attend votre accord avant de les envoyer aux clients.",
  ],
  note: "Votre équipe échange avec Léa sans installer d’application Ruchée. La mise en place d’un pilote et les fonctions disponibles sont à convenir ensemble.",
};
