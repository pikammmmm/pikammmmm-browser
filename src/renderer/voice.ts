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
 * Start a one-shot voice capture. Resolves with the transcribed text.
 * Throws if the browser/Electron build doesn't include speech recognition.
 */
export function startVoiceCapture(): Promise<string> {
  return new Promise((resolve, reject) => {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) {
      reject(
        new Error(
          'Voice capture not supported in this Electron build. (Chromium without the Google Speech API key.)',
        ),
      );
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
      reject(new Error(`Voice capture error: ${event.error}`));
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
