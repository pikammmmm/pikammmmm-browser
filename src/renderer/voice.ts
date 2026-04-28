interface SpeechRecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEvent {
  results: { length: number; [i: number]: SpeechRecognitionResult };
}
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
};

declare global {
  interface Window {
    SpeechRecognition?: { new (): SpeechRecognitionLike };
    webkitSpeechRecognition?: { new (): SpeechRecognitionLike };
  }
}

/**
 * Web Speech API technically exists in Electron's bundled Chromium, but the
 * actual transcription service requires Google's API key which Electron does
 * not ship. Every call ends with a `network` error. Detect Electron and hide
 * the mic instead of pretending it works.
 */
export function isVoiceSupported(): boolean {
  if (!(window.SpeechRecognition ?? window.webkitSpeechRecognition)) return false;
  const ua = navigator.userAgent;
  if (/Electron/.test(ua)) return false;
  return true;
}

const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': 'Microphone permission was denied. Allow it in your OS settings to use voice mode.',
  'service-not-allowed':
    "This Electron build doesn't include the Google Speech API key, so voice transcription isn't available. (This is a known Electron limitation, not a Pikammmmm Browser bug.)",
  'no-speech': 'No speech detected — try again.',
  'audio-capture': 'No microphone found.',
  network: 'Voice transcription needs internet — check your connection.',
};

/**
 * Start a one-shot voice capture. Resolves with the transcribed text.
 * Throws with a friendly message if the browser/Electron build doesn't
 * include speech recognition or fails for another reason.
 */
export function startVoiceCapture(): Promise<string> {
  return new Promise((resolve, reject) => {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) {
      reject(new Error("Voice capture isn't available in this build."));
      return;
    }
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = false;
    rec.interimResults = false;

    let resolved = false;
    rec.onresult = (event) => {
      const r = event.results[0];
      if (!r) return;
      resolved = true;
      resolve(r[0].transcript);
    };
    rec.onerror = (event) => {
      if (resolved) return;
      resolved = true;
      reject(new Error(ERROR_MESSAGES[event.error] ?? `Voice error: ${event.error}`));
    };
    rec.onend = () => {
      if (resolved) return;
      resolved = true;
      resolve('');
    };
    try {
      rec.start();
    } catch (e) {
      reject(e as Error);
    }
  });
}
