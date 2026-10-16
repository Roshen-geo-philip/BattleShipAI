/** Tiny WebAudio synth — no audio assets needed. Respects a persisted mute toggle. */
let ctx: AudioContext | null = null;
let muted = (() => {
  try {
    return localStorage.getItem('bs:muted') === '1';
  } catch {
    return false;
  }
})();

export function isMuted() {
  return muted;
}

export function setMuted(v: boolean) {
  muted = v;
  try {
    localStorage.setItem('bs:muted', v ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

function audio(): AudioContext | null {
  if (muted) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.12, slideTo?: number) {
  const a = audio();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, a.currentTime + dur);
  g.gain.setValueAtTime(gain, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(g).connect(a.destination);
  o.start();
  o.stop(a.currentTime + dur);
}

function noise(dur: number, gain = 0.2) {
  const a = audio();
  if (!a) return;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = a.createBufferSource();
  const g = a.createGain();
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 900;
  src.buffer = buf;
  g.gain.value = gain;
  src.connect(f).connect(g).connect(a.destination);
  src.start();
}

export const sfx = {
  hit: () => (noise(0.35, 0.3), tone(140, 0.25, 'square', 0.05, 60)),
  miss: () => tone(520, 0.18, 'sine', 0.08, 260),
  sunk: () => (noise(0.8, 0.35), tone(220, 0.7, 'sawtooth', 0.06, 50)),
  mine: () => (noise(0.5, 0.35), tone(880, 0.3, 'square', 0.05, 110)),
  radar: () => (tone(1200, 0.12, 'sine', 0.08), setTimeout(() => tone(1200, 0.3, 'sine', 0.05), 180)),
  click: () => tone(660, 0.05, 'triangle', 0.05),
  turn: () => (tone(440, 0.1, 'triangle', 0.06), setTimeout(() => tone(660, 0.15, 'triangle', 0.06), 110)),
  win: () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.25, 'triangle', 0.08), i * 140)),
};
