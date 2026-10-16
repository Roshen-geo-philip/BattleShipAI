import { useEffect, useState } from 'react';
import type { TimerInfo } from './types';

export function Countdown({ timer, label }: { timer: TimerInfo | null | undefined; label?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  if (!timer) return null;
  const ms = timer.paused ? timer.remaining ?? 0 : Math.max(0, timer.deadline - now);
  const s = Math.ceil(ms / 1000);
  const cls = timer.paused ? 'warn' : s <= 10 ? 'bad' : 'ok';
  return (
    <span className={`pill ${cls}`} role="timer" aria-live="off">
      ⏱ {label ?? (timer.kind === 'setup' ? 'Setup' : 'Turn')} {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
      {timer.paused && ' (paused — player disconnected)'}
    </span>
  );
}
