import { useState } from 'react';
import { DEFAULT_RULES, SHIP_CATALOG, type Difficulty } from '@battleship/engine';
import { AIGame } from './screens/AIGame';
import { LocalGame } from './screens/LocalGame';
import { OnlineScreen } from './screens/Online';
import { ShipMini } from './components/Board';
import { clearHistory, loadHistory, loadName, saveName } from './lib/history';
import { useOnline } from './lib/online';
import { isMuted, setMuted } from './lib/sound';

type Screen =
  | { id: 'menu' }
  | { id: 'ai-setup' }
  | { id: 'ai'; name: string; difficulty: Difficulty; key: number }
  | { id: 'local-setup' }
  | { id: 'local'; names: [string, string]; size: number; key: number }
  | { id: 'online'; code?: string }
  | { id: 'history' }
  | { id: 'rules' };

export default function App() {
  const joinCode = new URLSearchParams(window.location.search).get('join')?.toUpperCase() ?? undefined;
  const [screen, setScreen] = useState<Screen>(joinCode ? { id: 'online', code: joinCode } : { id: 'menu' });
  const [muted, setMute] = useState(isMuted());
  const online = useOnline();
  const menu = () => {
    if (joinCode) window.history.replaceState(null, '', window.location.pathname);
    setScreen({ id: 'menu' });
  };

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" type="button" onClick={menu} aria-label="Main menu">
          <img src="/favicon.svg" alt="" /> Logic Battleship
        </button>
        <div className="row">
          <button className="btn ghost" type="button" onClick={() => setScreen({ id: 'rules' })}>Rules</button>
          <button className="btn ghost" type="button" onClick={() => setScreen({ id: 'history' })}>History</button>
          <button className="btn ghost" type="button" aria-pressed={muted} onClick={() => (setMuted(!muted), setMute(!muted))} aria-label={muted ? 'Unmute sound' : 'Mute sound'}>
            {muted ? '🔇' : '🔊'}
          </button>
        </div>
      </header>
      <main>
        {screen.id === 'menu' && <MainMenu go={setScreen} />}
        {screen.id === 'ai-setup' && <AISetup onStart={(name, difficulty) => setScreen({ id: 'ai', name, difficulty, key: Date.now() })} onBack={menu} />}
        {screen.id === 'ai' && <AIGame key={screen.key} name={screen.name} difficulty={screen.difficulty} onExit={menu} />}
        {screen.id === 'local-setup' && <LocalSetup onStart={(names, size) => setScreen({ id: 'local', names, size, key: Date.now() })} onBack={menu} />}
        {screen.id === 'local' && <LocalGame key={screen.key} names={screen.names} size={screen.size} onExit={menu} />}
        {screen.id === 'online' && <OnlineScreen online={online} initialCode={screen.code} onExit={menu} />}
        {screen.id === 'history' && <History onBack={menu} />}
        {screen.id === 'rules' && <Rules onBack={menu} />}
      </main>
    </div>
  );
}

function MainMenu({ go }: { go: (s: Screen) => void }) {
  const modes = [
    { icon: '🧠', title: 'Versus AI', text: 'Face a first-order-logic AI on a 15×15 board.', to: { id: 'ai-setup' } as Screen },
    { icon: '🤝', title: 'Local 1v1', text: 'Pass-and-play on one device with privacy handovers.', to: { id: 'local-setup' } as Screen },
    { icon: '🌐', title: 'Online 1v1', text: 'Host a room, share a code or QR, duel a friend.', to: { id: 'online' } as Screen },
    { icon: '👥', title: 'Online 2v2', text: 'Two teams of two — round-robin duels, team score.', to: { id: 'online' } as Screen },
    { icon: '🛡', title: 'Online 5v5', text: 'Pick positions 1–5; shuffled duels decide the fleet.', to: { id: 'online' } as Screen },
  ];
  return (
    <div className="stack">
      <section className="stack" style={{ padding: '12px 0 8px' }}>
        <h1>Command the fleet.</h1>
        <p className="muted" style={{ maxWidth: 680 }}>
          Battleship with a points economy: earn points by firing, spend them on airstrikes, nukes, radar sweeps and hidden mines. Ten ship shapes, five modes,
          one authoritative engine.
        </p>
      </section>
      <div className="cards">
        {modes.map((m) => (
          <button key={m.title} type="button" className="mode-card" onClick={() => go(m.to)}>
            <span className="icon" aria-hidden>{m.icon}</span>
            <strong>{m.title}</strong>
            <span className="muted small">{m.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AISetup({ onStart, onBack }: { onStart: (name: string, d: Difficulty) => void; onBack: () => void }) {
  const [name, setName] = useState(loadName());
  const [difficulty, setDifficulty] = useState<Difficulty>('strategic');
  const info: Record<Difficulty, string> = {
    basic: 'Rules R1–R4 only: hits → adjacent candidates, otherwise random untested water.',
    strategic: '+ line extension (R7), placement enumeration (R5/R6), parity hunting and radar.',
    advanced: '+ full probability density over consistent placements, airstrikes, nukes and a setup mine.',
  };
  return (
    <div className="panel stack" style={{ maxWidth: 560 }}>
      <h2>Versus AI</h2>
      <label className="field">
        Your name
        <input type="text" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder="Captain" />
      </label>
      <div className="stack" role="radiogroup" aria-label="Difficulty">
        {(['basic', 'strategic', 'advanced'] as Difficulty[]).map((d) => (
          <button key={d} type="button" role="radio" aria-checked={difficulty === d} className={`btn ship-option ${difficulty === d ? 'active' : ''}`} onClick={() => setDifficulty(d)}>
            <span style={{ textTransform: 'capitalize' }}>{d}</span>
            <span className="muted small" style={{ textAlign: 'right' }}>{info[d]}</span>
          </button>
        ))}
      </div>
      <div className="row">
        <button className="btn primary big" type="button" onClick={() => (saveName(name), onStart(name, difficulty))}>Start battle</button>
        <button className="btn ghost" type="button" onClick={onBack}>Back</button>
      </div>
    </div>
  );
}

function LocalSetup({ onStart, onBack }: { onStart: (names: [string, string], size: number) => void; onBack: () => void }) {
  const [a, setA] = useState('Player 1');
  const [b, setB] = useState('Player 2');
  const [size, setSize] = useState(15);
  return (
    <div className="panel stack" style={{ maxWidth: 560 }}>
      <h2>Local 1v1</h2>
      <div className="grid-2">
        <label className="field">Player 1<input type="text" value={a} maxLength={20} onChange={(e) => setA(e.target.value)} /></label>
        <label className="field">Player 2<input type="text" value={b} maxLength={20} onChange={(e) => setB(e.target.value)} /></label>
      </div>
      <div className="row" role="radiogroup" aria-label="Board size">
        {[15, 5].map((s) => (
          <button key={s} type="button" role="radio" aria-checked={size === s} className={`btn ${size === s ? 'active' : ''}`} onClick={() => setSize(s)}>
            {s}×{s} · {s === 15 ? 5 : 3} ships
          </button>
        ))}
      </div>
      <div className="row">
        <button className="btn primary big" type="button" onClick={() => onStart([a, b], size)}>Start</button>
        <button className="btn ghost" type="button" onClick={onBack}>Back</button>
      </div>
    </div>
  );
}

function History({ onBack }: { onBack: () => void }) {
  const [list, setList] = useState(loadHistory());
  return (
    <div className="panel stack">
      <div className="row spread">
        <h2>Match history</h2>
        <div className="row">
          {list.length > 0 && <button className="btn ghost" type="button" onClick={() => (clearHistory(), setList([]))}>Clear</button>}
          <button className="btn" type="button" onClick={onBack}>Back</button>
        </div>
      </div>
      {list.length === 0 ? (
        <p className="muted">No finished matches on this device yet.</p>
      ) : (
        <table className="tbl">
          <thead><tr><th>When</th><th>Mode</th><th>Match</th><th>Winner</th><th>Scores</th></tr></thead>
          <tbody>
            {list.map((h) => (
              <tr key={h.id}>
                <td>{new Date(h.at).toLocaleString()}</td>
                <td>{h.mode}</td>
                <td>{h.summary}</td>
                <td>{h.winner ?? '—'}</td>
                <td className="small">{h.scores.map((s) => `${s.name}${s.team ? ` (${s.team})` : ''}: ${s.score}`).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Rules({ onBack }: { onBack: () => void }) {
  const r = DEFAULT_RULES;
  return (
    <div className="stack">
      <div className="row spread">
        <h1>How to play</h1>
        <button className="btn" type="button" onClick={onBack}>Back</button>
      </div>
      <div className="grid-2">
        <div className="panel">
          <h2>Turns & scoring</h2>
          <ul className="rules-list">
            <li>Everyone starts each battle with <b>{r.startingPoints} points</b>.</li>
            <li>Every manual shot at new water earns <b>+{r.manualAttackReward}</b>, hit or miss.</li>
            <li>A hit lets you keep firing. A miss locks manual fire, but you can still use abilities. The turn only passes when you press <b>End Turn</b>.</li>
            <li>Sinking a ship: attacker <b>+{r.sinkBonusAttacker}</b>, owner <b>+{r.sinkCompensationOwner}</b>. Abilities never earn the +1 shot reward, but a ship sunk by an ability still pays the sinking bonus.</li>
            <li>Score is everything you earn minus penalties. Spending on abilities lowers your balance, not your score. A team's score is the sum of its players' scores.</li>
          </ul>
        </div>
        <div className="panel">
          <h2>Abilities</h2>
          <ul className="rules-list">
            <li><b>✈ Airstrike ({r.abilityCosts.airstrike})</b> hits a full row or column.</li>
            <li><b>☢ Nuke ({r.abilityCosts.nuke})</b> hits a 2×2 area.</li>
            <li><b>📡 Radar ({r.abilityCosts.radar})</b> shows ship contacts and mines in a 3×3 area (shifted inward at the edges). It does no damage, and its results stay on your board.</li>
            <li><b>✹ Mine ({r.abilityCosts.mine})</b> goes on your own empty water, during setup or your turn. If an enemy fires on it: they lose {r.minePenaltyAttacker}, you gain {r.mineRewardOwner}, and their shot counts as a miss. An airstrike or nuke defuses a mine without points changing hands.</li>
            <li>Ability targets can include cells that were already hit. Those cells are skipped, with no extra damage and no reward.</li>
          </ul>
        </div>
      </div>
      <div className="panel stack">
        <h2>Ship catalog</h2>
        <div className="cards">
          {SHIP_CATALOG.map((t) => (
            <div key={t.id} className="row">
              <ShipMini cells={t.pattern.map(([x, y]) => ({ x, y }))} color={t.visual.color} />
              <span><b>{t.name}</b><br /><span className="muted small">{t.visual.description}</span></span>
            </div>
          ))}
        </div>
        <p className="muted small">A 15×15 battle uses 5 randomly chosen ships and a 5×5 battle uses 3. Both opponents in a duel always get the same shapes.</p>
      </div>
    </div>
  );
}
