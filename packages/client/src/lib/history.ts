export interface HistoryEntry {
  id: string;
  at: number;
  mode: string;
  summary: string;
  winner: string | null;
  scores: { name: string; score: number; team?: string }[];
}

const KEY = 'bs:history';

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveHistory(entry: HistoryEntry) {
  try {
    const list = loadHistory().filter((e) => e.id !== entry.id);
    list.unshift(entry);
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 30)));
  } catch {
    /* storage unavailable — history is a convenience only */
  }
}

export function clearHistory() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Saved online session for reconnection after reloads or network drops. */
export interface SavedSession {
  code: string;
  token: string;
  playerId: string;
  name: string;
}

export function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem('bs:session');
    return raw ? (JSON.parse(raw) as SavedSession) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: SavedSession | null) {
  try {
    if (s) localStorage.setItem('bs:session', JSON.stringify(s));
    else localStorage.removeItem('bs:session');
  } catch {
    /* ignore */
  }
}

export function loadName(): string {
  try {
    return localStorage.getItem('bs:name') ?? '';
  } catch {
    return '';
  }
}

export function saveName(n: string) {
  try {
    localStorage.setItem('bs:name', n);
  } catch {
    /* ignore */
  }
}
