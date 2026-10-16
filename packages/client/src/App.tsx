import { useEffect, useState } from 'react';
import { BOARD_CONFIG, DEFAULT_RULES, SHIP_CATALOG, type Difficulty } from '@battleship/engine';
import { AIGame } from './screens/AIGame';
import { LocalGame } from './screens/LocalGame';
import { OnlineScreen } from './screens/Online';
import { ShipMini } from './components/Board';
import { AIExplainer } from './components/AIExplainer';
import { clearHistory, loadHistory, loadName, saveName } from './lib/history';
import { useOnline } from './lib/online';
import { isMuted, setMuted } from './lib/sound';
import { APP_NAME } from './lib/brand';

type Screen =
  | { id: 'menu' }
  | { id: 'ai-setup' }
  | { id: 'ai'; name: string; difficulty: Difficulty; key: number }
  | { id: 'ai-guide' }
  | { id: 'local-setup' }
  | { id: 'local'; names: [string, string]; key: number }
  | { id: 'online'; code?: string }
  | { id: 'history' }
  | { id: 'rules' };

const BOARD_LABEL = `${BOARD_CONFIG.size}×${BOARD_CONFIG.size} · ${BOARD_CONFIG.shipCount} ships`;

export default function App() {
  const joinCode = new URLSearchParams(window.location.search).get('join')?.toUpperCase() ?? undefined;
  const [screen, setScreen] = useState<Screen>(joinCode ? { id: 'online', code: joinCode } : { id: 'menu' });
  const [muted, setMute] = useState(isMuted());
  const online = useOnline();
  const menu = () => {
    if (joinCode) window.history.replaceState(null, '', window.location.pathname);
    setScreen({ id: 'menu' });
  };

  useEffect(() => {
    document.title = APP_NAME;
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen.id]);

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" type="button" onClick={menu} aria-label={`${APP_NAME} — main menu`}>
          <span className="brand-mark" aria-hidden><i /><i /><i /></span>
          <span className="brand-name">{APP_NAME}</span>
        </button>
        <nav className="nav" aria-label="Site">
          <button className="nav-link" type="button" aria-current={screen.id === 'rules' ? 'page' : undefined} onClick={() => setScreen({ id: 'rules' })}>Rules</button>
          <button className="nav-link" type="button" aria-current={screen.id === 'history' ? 'page' : undefined} onClick={() => setScreen({ id: 'history' })}>History</button>
          <button className="icon-btn" type="button" aria-pressed={muted} onClick={() => (setMuted(!muted), setMute(!muted))} aria-label={muted ? 'Unmute sound' : 'Mute sound'} title={muted ? 'Unmute' : 'Mute'}>
            {muted ? '🔇' : '🔊'}
          </button>
        </nav>
      </header>
      <main className="page">
        {screen.id === 'menu' && <MainMenu go={setScreen} />}
        {screen.id === 'ai-setup' && (
          <AISetup onStart={(name, difficulty) => setScreen({ id: 'ai', name, difficulty, key: Date.now() })} onGuide={() => setScreen({ id: 'ai-guide' })} onBack={menu} />
        )}
        {screen.id === 'ai' && <AIGame key={screen.key} name={screen.name} difficulty={screen.difficulty} onExit={menu} />}
        {screen.id === 'ai-guide' && (
          <div className="stack lg">
            <button className="text-link" type="button" onClick={() => setScreen({ id: 'ai-setup' })} style={{ alignSelf: 'flex-start' }}>← Versus AI</button>
            <AIExplainer />
          </div>
        )}
        {screen.id === 'local-setup' && <LocalSetup onStart={(names) => setScreen({ id: 'local', names, key: Date.now() })} onBack={menu} />}
        {screen.id === 'local' && <LocalGame key={screen.key} names={screen.names} onExit={menu} />}
        {screen.id === 'online' && <OnlineScreen online={online} initialCode={screen.code} onExit={menu} />}
        {screen.id === 'history' && <History onBack={menu} />}
        {screen.id === 'rules' && <Rules onBack={menu} />}
      </main>
    </div>
  );
}

function MainMenu({ go }: { go: (s: Screen) => void }) {
  const modes = [
    { title: 'Versus AI', text: 'Duel an opponent that reasons in first-order logic, and watch every rule it fires.', meta: 'Three difficulties', to: { id: 'ai-setup' } as Screen },
    { title: 'Local PNP', text: 'Pass and play on one device. A privacy screen hides each fleet at every handover.', meta: '2 players · one device', to: { id: 'local-setup' } as Screen },
    { title: 'Online', text: 'Host a room, share the code or QR, and play 1v1, 2v2 or 5v5 over the network.', meta: '1v1 · 2v2 · 5v5', to: { id: 'online' } as Screen },
  ];
  return (
    <div className="stack xl">
      <section className="hero">
        <div className="m-stripe short" />
        <h1>Command<br />the fleet.</h1>
        <p className="lead">
          Earn points with every shot and spend them on airstrikes, nukes, radar sweeps and hidden mines. {BOARD_LABEL}, ten hull shapes, one authoritative
          engine.
        </p>
      </section>
      <nav className="mode-grid" aria-label="Game modes">
        {modes.map((m, i) => (
          <button key={m.title} type="button" className="mode-card" onClick={() => go(m.to)}>
            <span className="index">0{i + 1}</span>
            <span className="title">{m.title}</span>
            <span>{m.text}</span>
            <span className="meta">
              <span>{m.meta}</span>
              <span className="arrow" aria-hidden>→</span>
            </span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function AISetup({ onStart, onGuide, onBack }: { onStart: (name: string, d: Difficulty) => void; onGuide: () => void; onBack: () => void }) {
  const [name, setName] = useState(loadName());
  const [difficulty, setDifficulty] = useState<Difficulty>('strategic');
  const info: Record<Difficulty, string> = {
    basic: 'Core rules only: chases hits through adjacent candidates, otherwise random untested water. No abilities.',
    strategic: 'Adds line extension (R7), radar targets (R9), a placement model and parity hunting. Uses radar.',
    advanced: 'Maximum placement density, plus airstrikes, nukes, radar and defensive mines.',
  };
  return (
    <div className="stack lg narrow">
      <button className="text-link" type="button" onClick={onBack} style={{ alignSelf: 'flex-start' }}>← Modes</button>
      <div className="stack" style={{ gap: 8 }}>
        <span className="caption">{BOARD_LABEL}</span>
        <h1 style={{ fontSize: 'clamp(2rem, 6vw, 3.5rem)' }}>Versus AI</h1>
      </div>
      <label className="field">
        Your name
        <input type="text" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder="Captain" />
      </label>
      <div className="stack" style={{ gap: 8 }}>
        <h3 id="difficulty-label">Difficulty</h3>
        <div className="option-list" role="radiogroup" aria-labelledby="difficulty-label">
          {(['basic', 'strategic', 'advanced'] as Difficulty[]).map((d) => (
            <button key={d} type="button" role="radio" aria-checked={difficulty === d} className="option" onClick={() => setDifficulty(d)}>
              <strong>{d}</strong>
              <span className="small">{info[d]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="row">
        <button className="btn solid big" type="button" onClick={() => (saveName(name), onStart(name, difficulty))}>Start battle</button>
        <button className="text-link" type="button" onClick={onGuide}>How the AI thinks →</button>
      </div>
    </div>
  );
}

function LocalSetup({ onStart, onBack }: { onStart: (names: [string, string]) => void; onBack: () => void }) {
  const [a, setA] = useState('Player 1');
  const [b, setB] = useState('Player 2');
  return (
    <div className="stack lg narrow">
      <button className="text-link" type="button" onClick={onBack} style={{ alignSelf: 'flex-start' }}>← Modes</button>
      <div className="stack" style={{ gap: 8 }}>
        <span className="caption">{BOARD_LABEL} · pass and play</span>
        <h1 style={{ fontSize: 'clamp(2rem, 6vw, 3.5rem)' }}>Local PNP</h1>
        <p className="small">Two players share this device. Each handover shows a privacy screen so neither player sees the other's fleet.</p>
      </div>
      <div className="grid-2">
        <label className="field">Player 1<input type="text" value={a} maxLength={20} onChange={(e) => setA(e.target.value)} /></label>
        <label className="field">Player 2<input type="text" value={b} maxLength={20} onChange={(e) => setB(e.target.value)} /></label>
      </div>
      <div className="row">
        <button className="btn solid big" type="button" onClick={() => onStart([a, b])}>Start</button>
      </div>
    </div>
  );
}

function History({ onBack }: { onBack: () => void }) {
  const [list, setList] = useState(loadHistory());
  return (
    <div className="stack lg">
      <div className="row spread">
        <h1 style={{ fontSize: 'clamp(2rem, 6vw, 3.5rem)' }}>Match history</h1>
        <div className="row">
          {list.length > 0 && <button className="btn ghost" type="button" onClick={() => (clearHistory(), setList([]))}>Clear</button>}
          <button className="btn" type="button" onClick={onBack}>Back</button>
        </div>
      </div>
      <p className="small muted">Stored on this device only.</p>
      {list.length === 0 ? (
        <p>No finished matches on this device yet.</p>
      ) : (
        <div className="table-wrap">
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
        </div>
      )}
    </div>
  );
}

function Rules({ onBack }: { onBack: () => void }) {
  const r = DEFAULT_RULES;
  return (
    <div className="stack lg">
      <div className="row spread">
        <h1 style={{ fontSize: 'clamp(2rem, 6vw, 3.5rem)' }}>How to play</h1>
        <button className="btn" type="button" onClick={onBack}>Back</button>
      </div>
      <div className="grid-2">
        <div className="panel stack">
          <h2>Turns & scoring</h2>
          <ul className="rules-list">
            <li>Everyone starts each battle with <b>{r.startingPoints} points</b>.</li>
            <li>Every manual shot at new water earns <b>+{r.manualAttackReward}</b>, hit or miss.</li>
            <li>A hit lets you keep firing. A miss locks manual fire, but abilities stay available.</li>
            <li><b>You cannot end your turn while you still have a legal shot.</b> End Turn unlocks after a miss, or when no untested enemy cell remains. Online, the turn timer passes the turn for you if it runs out.</li>
            <li>Sinking a ship: attacker <b>+{r.sinkBonusAttacker}</b>, owner <b>+{r.sinkCompensationOwner}</b>. Abilities never earn the +1 shot reward, but a ship sunk by an ability still pays the sinking bonus.</li>
            <li>Score is everything you earn minus penalties. Spending on abilities lowers your balance, not your score. A team's score is the sum of its players' scores.</li>
          </ul>
        </div>
        <div className="panel stack">
          <h2>Abilities</h2>
          <ul className="rules-list">
            <li><b>Airstrike ({r.abilityCosts.airstrike})</b> hits a full row or column.</li>
            <li><b>Nuke ({r.abilityCosts.nuke})</b> hits a 2×2 area.</li>
            <li><b>Radar ({r.abilityCosts.radar})</b> shows ship contacts and mines in a 3×3 area (shifted inward at the edges). It does no damage, and its results stay on your board.</li>
            <li><b>Mine ({r.abilityCosts.mine})</b> goes on your own empty water, during setup or your turn. If an enemy fires on it: they lose {r.minePenaltyAttacker}, you gain {r.mineRewardOwner}, and their shot counts as a miss. An airstrike or nuke defuses a mine without points changing hands.</li>
            <li>Ability targets can include cells that were already hit. Those cells are skipped, with no extra damage and no reward. The AI follows exactly the same costs and restrictions.</li>
          </ul>
        </div>
      </div>
      <div className="panel stack">
        <h2>Ship catalog</h2>
        <div className="cards">
          {SHIP_CATALOG.map((t) => (
            <div key={t.id} className="row" style={{ flexWrap: 'nowrap' }}>
              <ShipMini cells={t.pattern.map(([x, y]) => ({ x, y }))} color={t.visual.color} />
              <span><b>{t.name}</b><br /><span className="muted small">{t.visual.description}</span></span>
            </div>
          ))}
        </div>
        <p className="muted small">Every battle is played on a {BOARD_CONFIG.size}×{BOARD_CONFIG.size} board with {BOARD_CONFIG.shipCount} ships chosen at random from these ten, and the set is proven to fit before play. Both opponents in a duel always get the same shapes.</p>
      </div>
    </div>
  );
}
