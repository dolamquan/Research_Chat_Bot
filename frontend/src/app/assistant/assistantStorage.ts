/** Per-browser preferences for the assistant. Everything durable lives on the server. */

const PREFIX = "zoetrope.assistant.";

export const STORAGE_KEYS = {
  session: `${PREFIX}session`,
  muted: `${PREFIX}muted`,
  tts: `${PREFIX}tts`,
  voice: `${PREFIX}voice`,
  dock: `${PREFIX}dock`,
  hintSeen: `${PREFIX}hintSeen`,
  voiceEnabled: `${PREFIX}voiceEnabled`,
} as const;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode, blocked); preferences are optional.
  }
}

export const assistantStorage = {
  getSessionId: () => read(STORAGE_KEYS.session),
  setSessionId: (id: string | null) => write(STORAGE_KEYS.session, id),

  getMuted: () => read(STORAGE_KEYS.muted) === "1",
  setMuted: (muted: boolean) => write(STORAGE_KEYS.muted, muted ? "1" : "0"),

  getTtsEnabled: () => read(STORAGE_KEYS.tts) !== "off",
  setTtsEnabled: (enabled: boolean) => write(STORAGE_KEYS.tts, enabled ? "on" : "off"),

  getVoiceUri: () => read(STORAGE_KEYS.voice),
  setVoiceUri: (uri: string | null) => write(STORAGE_KEYS.voice, uri),

  getDockExpanded: () => read(STORAGE_KEYS.dock) === "expanded",
  setDockExpanded: (expanded: boolean) => write(STORAGE_KEYS.dock, expanded ? "expanded" : "collapsed"),

  getHintSeen: () => read(STORAGE_KEYS.hintSeen) === "1",
  setHintSeen: () => write(STORAGE_KEYS.hintSeen, "1"),

  getVoiceEnabled: () => read(STORAGE_KEYS.voiceEnabled) === "1",
  setVoiceEnabled: (enabled: boolean) => write(STORAGE_KEYS.voiceEnabled, enabled ? "1" : "0"),
};
