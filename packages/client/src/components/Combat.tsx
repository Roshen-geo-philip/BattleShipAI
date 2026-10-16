import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  endTurnBlocker,
  getTemplate,
  key,
  radarWindow,
  type AbilityId,
  type BattleEvent,
  type BattleView,
  type BoardView,
} from '@battleship/engine';
import { Board, coordName, colName, ShipMini } from './Board';
import { Countdown } from './Countdown';
import type { ActionInput, Send, TimerInfo } from './types';
import { sfx } from '../lib/sound';

type Tool = 'attack' | 'airstrike' | 'nuke' | 'radar' | 'mine' | 'predict';

interface Props {
  view: BattleView;
  /** The player whose perspective this is (actor). */
  meId: string;
  /** False when spectating, waiting for the AI, etc. */
  canAct: boolean;
  send: Send;
  timer?: TimerInfo | null;
  aiReasoning?: string[];
  /** Spectator mode: show both boards read-only. */
  spectator?: boolean;
  extraSide?: ReactNode;
}

function usePredictions(storageKey: string) {
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storageKey) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (k: string) => {
    const next = new Set(set);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setSet(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify([...next]));
    } catch {
      /* predictions are a local convenience only */
    }
  };
  const clear = () => {
    setSet(new Set());
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  };
  return { predictions: set, toggle, clear };
}

export function describeEvent(e: BattleEvent, name: (id: string) => string): { text: string; cls: string } | null {
  switch (e.kind) {
    case 'battle-started':
      return { text: `Battle started — ${name(e.firstPlayerId)} goes first`, cls: '' };
    case 'attack': {
      const hits = e.cells.filter((c) => c.result === 'hit').length;
      const where = e.source === 'manual' ? coordName(e.cells[0].x, e.cells[0].y) : e.source === 'nuke' ? `2×2 at ${coordName(e.cells[0].x, e.cells[0].y)}` : 'a full line';
      const res =
        e.source === 'manual'
          ? e.cells[0].result === 'hit' ? 'HIT' : e.cells[0].result === 'mine' ? 'triggered a MINE' : 'miss'
          : `${hits} hit(s)${e.cells.some((c) => c.result === 'mine-defused') ? ', mine defused' : ''}`;
      const sunk = e.sunk.length ? ` · sank ${e.sunk.map((s) => getTemplate(s.templateId).name).join(', ')}!` : '';
      const label = e.source === 'manual' ? 'fired at' : e.source === 'nuke' ? 'nuked' : 'airstruck';
      return { text: `${name(e.attackerId)} ${label} ${where}: ${res}${sunk}`, cls: e.sunk.length ? 'l-sunk' : hits ? 'l-hit' : e.cells.some((c) => c.result === 'mine') ? 'l-mine' : '' };
    }
    case 'mine-triggered':
      return { text: `Mine! ${name(e.attackerId)} loses points, ${name(e.ownerId)} is rewarded`, cls: 'l-mine' };
    case 'radar':
      return { text: `${name(e.attackerId)} ran a radar sweep at ${coordName(e.x, e.y)}`, cls: 'l-radar' };
    case 'purchase':
      return e.ability === 'mine' ? { text: `${name(e.playerId)} laid a hidden mine (−${e.cost})`, cls: 'l-mine' } : null;
    case 'manual-locked':
      return { text: `${name(e.playerId)} missed — manual fire locked for the turn`, cls: '' };
    case 'turn-ended':
      return { text: `Turn ${e.turn}: ${name(e.nextPlayerId)} to move${e.timedOut ? ' (previous turn timed out)' : ''}`, cls: '' };
    case 'battle-finished':
      return { text: `${name(e.winnerId)} ${name(e.winnerId) === 'You' ? 'win' : 'wins'} (${e.reason === 'forfeit' ? 'forfeit' : 'all ships sunk'})`, cls: 'l-sunk' };
    default:
      return null;
  }
}

/** Who performed an event, for "result of your last action" feedback. */
function actorOf(e: BattleEvent): string | null {
  if (e.kind === 'attack' || e.kind === 'radar' || e.kind === 'mine-triggered') return e.attackerId;
  if (e.kind === 'purchase') return e.playerId;
  return null;
}

const ABILITY_INFO: Record<Exclude<Tool, 'predict'>, { label: string; desc: string }> = {
  attack: { label: 'Fire', desc: 'One cell · +1 pt · a hit keeps your turn' },
  airstrike: { label: 'Airstrike', desc: 'Hits a full row or column' },
  nuke: { label: 'Nuke', desc: 'Hits a 2×2 area' },
  radar: { label: 'Radar', desc: 'Scans 3×3 for ships & mines, no damage' },
  mine: { label: 'Mine', desc: 'Hidden mine on your own empty water' },
};

export function Combat({ view, meId, canAct, send, timer, aiReasoning, spectator, extraSide }: Props) {
  const oppId = view.playerOrder.find((p) => p !== meId)!;
  const me = view.players[meId];
  const opp = view.players[oppId];
  const myTurn = view.phase === 'active' && view.turn?.playerId === meId && canAct && !spectator;
  const locked = !!view.turn?.manualLocked;
  const costs = view.rules.abilityCosts;
  const enemyBoard = view.boards[oppId];
  const myBoard = view.boards[meId];
  const [tool, setTool] = useState<Tool>('attack');
  const [axis, setAxis] = useState<'row' | 'col'>('row');
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Map<string, string>>(new Map());
  const { predictions, toggle: togglePrediction, clear: clearPredictions } = usePredictions(`bs:pred:${view.id}:${meId}`);
  const seen = useRef<Set<string> | null>(null);
  const names = (id: string) => (id === meId && !spectator ? 'You' : view.players[id]?.name ?? '?');
  const mineMode = tool === 'mine' && myTurn;
  const defaultTool: Tool = myTurn && !locked ? 'attack' : 'predict';

  // Animate + sound for new events (first render only records what already happened).
  useEffect(() => {
    const ids = view.log.map((e, i) => ('eventId' in e ? `${e.kind}:${e.eventId}` : `${e.kind}:${i}:${JSON.stringify(e)}`));
    if (!seen.current) {
      seen.current = new Set(ids);
      return;
    }
    const fresh = view.log.filter((_, i) => !seen.current!.has(ids[i]));
    ids.forEach((id) => seen.current!.add(id));
    if (!fresh.length) return;
    const f = new Map<string, string>();
    for (const e of fresh) {
      if (e.kind === 'attack') {
        const board = e.attackerId === meId ? oppId : meId;
        for (const c of e.cells) if (c.result !== 'skipped') f.set(`${board}:${key(c.x, c.y)}`, c.result === 'hit' ? 'flash-hit' : 'flash-miss');
        if (e.sunk.length) sfx.sunk();
        else if (e.cells.some((c) => c.result === 'mine')) sfx.mine();
        else if (e.cells.some((c) => c.result === 'hit')) sfx.hit();
        else sfx.miss();
      } else if (e.kind === 'radar') {
        const board = e.attackerId === meId ? oppId : meId;
        for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) f.set(`${board}:${key(e.x + dx, e.y + dy)}`, 'flash-radar');
        sfx.radar();
      } else if (e.kind === 'turn-ended' && e.nextPlayerId === meId) sfx.turn();
      else if (e.kind === 'battle-finished') sfx.win();
    }
    setFlash(f);
    const t = setTimeout(() => setFlash(new Map()), 900);
    return () => clearTimeout(t);
  }, [view.log, meId, oppId]);

  // A battle begins below the (scrolled) placement screen on small devices: bring the boards into view.
  useEffect(() => {
    if (!spectator) window.scrollTo({ top: 0 });
  }, [view.id, spectator]);

  // Keep the selected tool legal as the turn state changes.
  useEffect(() => {
    if (!myTurn && tool !== 'predict') setTool('predict');
    else if (myTurn && locked && tool === 'attack') setTool('predict');
    else if (myTurn && !locked && tool === 'predict') setTool('attack');
  }, [locked, myTurn]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape leaves any targeting mode (mine placement included).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTool(defaultTool);
        setError(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [defaultTool]);

  const fire = async (a: ActionInput) => {
    setError(null);
    const res = await send(a);
    if (!res.ok) setError(res.error ?? 'Action rejected');
    else if (a.type !== 'attack' && a.type !== 'endTurn') setTool(locked ? 'predict' : 'attack');
    return res.ok;
  };

  /* ---------------------------- targeting ---------------------------- */
  const targetArea = useMemo(() => {
    const s = new Set<string>();
    if (!hover) return s;
    const n = view.size;
    if (tool === 'attack' || tool === 'predict') s.add(key(hover.x, hover.y));
    if (tool === 'airstrike') for (let i = 0; i < n; i++) s.add(axis === 'row' ? key(i, hover.y) : key(hover.x, i));
    if (tool === 'nuke') {
      const x = Math.min(hover.x, n - 2);
      const y = Math.min(hover.y, n - 2);
      [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([dx, dy]) => s.add(key(x + dx, y + dy)));
    }
    if (tool === 'radar') {
      const w = radarWindow(n, hover.x, hover.y);
      for (let dy = 0; dy < w.size; dy++) for (let dx = 0; dx < w.size; dx++) s.add(key(w.x + dx, w.y + dy));
    }
    return s;
  }, [hover, tool, axis, view.size]);

  /** Why a mine cannot go on (x, y) of your own board — mirrors the engine's placeMine checks. */
  const mineBlocker = (x: number, y: number): string | null => {
    const k = key(x, y);
    if (myBoard.ships.some((sh) => sh.cells.some((c) => key(c.x, c.y) === k))) return 'Mines cannot go on ship cells';
    if (myBoard.mines.some((m) => key(m.x, m.y) === k)) return 'There is already a mine here';
    if (myBoard.shots.some((s) => key(s.x, s.y) === k)) return 'That cell has already been attacked';
    return null;
  };

  const clickEnemy = (x: number, y: number) => {
    if (mineMode) {
      setError('Mine placement targets your own board — choose a cell there, or cancel.');
      return;
    }
    if (tool === 'predict' || !myTurn) {
      if (!enemyBoard.shots.some((s) => s.x === x && s.y === y)) togglePrediction(key(x, y));
      return;
    }
    const n = view.size;
    if (tool === 'attack') fire({ type: 'attack', x, y });
    else if (tool === 'airstrike') fire({ type: 'airstrike', axis, index: axis === 'row' ? y : x });
    else if (tool === 'nuke') fire({ type: 'nuke', x: Math.min(x, n - 2), y: Math.min(y, n - 2) });
    else if (tool === 'radar') fire({ type: 'radar', x, y });
  };

  const clickOwn = async (x: number, y: number) => {
    if (!mineMode) return;
    const blocked = mineBlocker(x, y);
    if (blocked) return setError(`${coordName(x, y)}: ${blocked}`);
    if (await fire({ type: 'placeMine', x, y })) sfx.click();
  };

  /* ----------------------------- rendering ---------------------------- */
  const enemyCell = (board: BoardView, viewerSide: boolean) => {
    const shots = new Map(board.shots.map((s) => [key(s.x, s.y), s]));
    const sunk = new Map<string, string>();
    for (const sh of board.ships) if (sh.sunk) for (const c of sh.cells) sunk.set(key(c.x, c.y), sh.templateId);
    const mines = new Map(board.mines.map((m) => [key(m.x, m.y), m]));
    // Only scans made against THIS board (by its opponent) and visible to the viewer.
    const scanner = view.playerOrder.find((p) => p !== board.ownerId)!;
    const radar = new Map<string, boolean>();
    for (const sc of view.radar[scanner] ?? []) for (const c of sc.cells) radar.set(key(c.x, c.y), c.ship);
    return (x: number, y: number) => {
      const k = key(x, y);
      const cls: string[] = [];
      let label = 'untested';
      const shot = shots.get(k);
      if (sunk.has(k)) {
        cls.push('sunk-enemy');
        label = `sunk ${getTemplate(sunk.get(k)!).name}`;
      }
      if (shot?.result === 'hit') (cls.push('hit'), (label = sunk.has(k) ? label : 'hit'));
      else if (shot?.result === 'miss') (cls.push('miss'), (label = 'miss'));
      const mine = mines.get(k);
      if (mine) {
        cls.push(mine.outcome === 'triggered' ? 'mine-hit' : mine.outcome === 'defused' ? 'mine-defused' : 'mine-active');
        label = `mine (${mine.outcome ?? 'detected'})`;
      } else if (shot?.result === 'mine') cls.push('mine-hit');
      if (radar.has(k) && !shot) {
        cls.push(radar.get(k) ? 'radar-ship' : 'radar-empty');
        label = radar.get(k) ? 'radar: ship contact' : 'radar: clear';
      }
      if (viewerSide && predictions.has(k)) (cls.push('predict'), (label += ', predicted'));
      if (viewerSide && !mineMode && targetArea.has(k) && (myTurn || tool === 'predict')) cls.push('target');
      if (viewerSide && myTurn && tool === 'attack' && (locked || shot)) cls.push('locked');
      if (!viewerSide) cls.push('static');
      const fl = flash.get(`${board.ownerId}:${k}`);
      if (fl) cls.push(fl);
      return { cls: cls.join(' '), label };
    };
  };

  const ownCell = (board: BoardView) => {
    const ships = new Map<string, { t: string; hit: boolean; sunk: boolean }>();
    for (const sh of board.ships) sh.cells.forEach((c, i) => ships.set(key(c.x, c.y), { t: sh.templateId, hit: sh.hits[i], sunk: sh.sunk }));
    const shots = new Map(board.shots.map((s) => [key(s.x, s.y), s]));
    const mines = new Map(board.mines.map((m) => [key(m.x, m.y), m]));
    return (x: number, y: number) => {
      const k = key(x, y);
      const cls: string[] = [];
      let label = 'water';
      const style: Record<string, string> = {};
      const s = ships.get(k);
      if (s) {
        cls.push('ship');
        if (s.sunk) cls.push('sunk');
        style['--ship-color'] = getTemplate(s.t).visual.color;
        label = `${getTemplate(s.t).name}${s.sunk ? ' (sunk)' : s.hit ? ' (damaged)' : ''}`;
      }
      const shot = shots.get(k);
      if (shot?.result === 'hit') cls.push('hit');
      else if (shot?.result === 'miss') (cls.push('miss'), (label = 'enemy miss'));
      const m = mines.get(k);
      if (m) {
        cls.push(m.outcome === 'triggered' ? 'mine-hit' : m.outcome === 'defused' ? 'mine-defused' : 'mine-active');
        label = `your mine${m.outcome ? ` (${m.outcome})` : ''}`;
      }
      if (mineMode) {
        const ok = !s && !m && !shot;
        if (ok) (cls.push('mine-valid'), (label += ', valid mine cell'));
        if (hover && hover.x === x && hover.y === y) cls.push(ok ? 'preview-ok' : 'preview-bad');
      } else cls.push('static');
      const fl = flash.get(`${board.ownerId}:${k}`);
      if (fl) cls.push(fl);
      return { cls: cls.join(' '), label, style };
    };
  };

  const abilityBlocker = (a: AbilityId): string | null => {
    if (!myTurn) return 'Not your turn';
    if (locked && !view.rules.allowAbilitiesAfterMiss) return 'Disabled after a miss';
    if ((view.turn?.abilitiesUsed ?? 0) > 0 && !view.rules.allowMultipleAbilitiesPerTurn) return 'Already used this turn';
    if (a === 'mine' && !view.rules.allowMinesInTurn) return 'Setup only';
    if (me.balance < costs[a]) return `Need ${costs[a] - me.balance} more pts`;
    return null;
  };

  const tools: { id: Exclude<Tool, 'predict'>; cost?: number; blocked: string | null }[] = [
    { id: 'attack', blocked: !myTurn ? 'Not your turn' : locked ? 'Locked after a miss' : null },
    { id: 'airstrike', cost: costs.airstrike, blocked: abilityBlocker('airstrike') },
    { id: 'nuke', cost: costs.nuke, blocked: abilityBlocker('nuke') },
    { id: 'radar', cost: costs.radar, blocked: abilityBlocker('radar') },
    { id: 'mine', cost: costs.mine, blocked: abilityBlocker('mine') },
  ];

  const endBlocked = view.turn ? endTurnBlocker(view.turn, enemyBoard.shots.length, view.size) : 'Battle not active';
  const turnName = view.turn ? names(view.turn.playerId) : '';
  const log = view.log.map((e) => describeEvent(e, names)).filter(Boolean).slice(-16).reverse() as { text: string; cls: string }[];
  const lastMine = [...view.log].reverse().find((e) => actorOf(e) === meId);
  const feedback = !spectator && lastMine ? describeEvent(lastMine, names)?.text : null;
  const fleetStatus = (board: BoardView) =>
    view.templateIds.map((t) => {
      const sunk = board.ships.some((s) => s.templateId === t && s.sunk);
      const tpl = getTemplate(t);
      return (
        <div key={t} className={`ship-row ${sunk ? 'sunk' : ''}`}>
          <ShipMini cells={tpl.pattern.map(([x, y]) => ({ x, y }))} color={sunk ? '#5c1710' : tpl.visual.color} />
          {tpl.name}
        </div>
      );
    });

  const enemyPanel = (variant: 'primary' | 'secondary') => (
    <section className={`board-frame ${variant === 'primary' ? 'primary-frame' : ''}`} aria-label={`${opp.name}'s waters`}>
      <div className="board-head">
        <h3>{spectator ? `${opp.name}'s waters` : 'Enemy waters'}</h3>
        <span className="small muted">{opp.name} · {enemyBoard.shipsRemaining} ships left</span>
      </div>
      <Board
        size={view.size}
        variant={variant}
        ariaLabel={`${opp.name}'s board`}
        cell={enemyCell(enemyBoard, !spectator)}
        onCellClick={spectator ? undefined : clickEnemy}
        onCellHover={variant === 'primary' ? setHover : undefined}
        disabled={spectator}
      />
      {variant === 'primary' && !spectator && (
        <p className="small muted" aria-live="polite">
          {hover ? coordName(hover.x, hover.y) : 'Hover or use arrow keys to aim'}
          {tool === 'airstrike' && hover ? ` · ${axis === 'row' ? `row ${hover.y + 1}` : `column ${colName(hover.x)}`}` : ''}
          {tool === 'predict' ? ' · mark suspected ship cells (private, no effect on scoring)' : ''}
        </p>
      )}
    </section>
  );

  const ownPanel = (variant: 'primary' | 'secondary') => (
    <section className={`board-frame ${variant === 'primary' ? 'primary-frame' : ''} ${mineMode ? 'focused' : ''}`} aria-label={spectator ? `${me.name}'s waters` : 'Your fleet'}>
      <div className="board-head">
        <h3>{spectator ? `${me.name}'s waters` : mineMode ? 'Your waters — place mine' : 'Your fleet'}</h3>
        <span className="small muted">{myBoard.shipsRemaining} ships afloat</span>
      </div>
      <Board
        size={view.size}
        variant={variant}
        ariaLabel={spectator ? `${me.name}'s board` : mineMode ? 'Your board — choose a mine cell' : 'Your board'}
        cell={myBoard.revealed ? ownCell(myBoard) : enemyCell(myBoard, false)}
        onCellClick={clickOwn}
        onCellHover={mineMode ? setHover : undefined}
        disabled={spectator || !mineMode}
      />
      {mineMode && (
        <p className="small" aria-live="polite">
          {hover ? `${coordName(hover.x, hover.y)} · ${mineBlocker(hover.x, hover.y) ?? 'valid — click to lay the mine'}` : 'Outlined cells are valid empty water.'}
        </p>
      )}
    </section>
  );

  const statusText = () => {
    if (view.phase === 'finished') return { cls: 'over', title: 'Battle over', sub: `${names(view.winnerId!)} ${view.winnerId === meId && !spectator ? 'win' : 'wins'} this battle` };
    if (spectator) return { cls: '', title: `${turnName}'s turn`, sub: locked ? 'Missed — finishing the turn' : 'Firing' };
    if (myTurn && !locked) return { cls: 'mine', title: 'Your turn — fire', sub: 'A hit keeps your turn going. End Turn unlocks after a miss.' };
    if (myTurn) return { cls: 'mine', title: 'You missed', sub: 'Manual fire is locked. Use an ability or end your turn.' };
    return { cls: '', title: `${turnName}'s turn`, sub: locked ? 'They missed and are finishing their turn' : 'Waiting for their move…' };
  };
  const status = statusText();

  return (
    <div className="stack">
      <div className="status-bar">
        <div className={`turn-status ${status.cls}`} role="status">
          <strong>{status.title}</strong>
          <span>{status.sub}</span>
        </div>
        <div className="row" style={{ alignItems: 'center' }}>
          <span className="pill num">Turn {view.turn?.number ?? '–'}</span>
          <Countdown timer={view.phase === 'active' ? timer : null} />
        </div>
        {!spectator && (
          <div className="end-turn">
            <button className="btn primary" type="button" disabled={!myTurn || !!endBlocked} aria-describedby="end-turn-hint" onClick={() => fire({ type: 'endTurn' })}>
              End turn
            </button>
            <span id="end-turn-hint" className="hint">
              {!myTurn ? 'Available on your turn' : endBlocked ? 'Locked: you still have a legal shot' : 'Ready — pass the turn'}
            </span>
          </div>
        )}
      </div>

      {!spectator && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row spread">
            <h3>Actions</h3>
            <span className="small muted num">
              Balance <b>{me.balance}</b> pts{(view.turn?.abilitiesUsed ?? 0) > 0 && myTurn ? ` · ${view.turn!.abilitiesUsed} ability use(s) this turn` : ''}
            </span>
          </div>
          <div className="abilities" role="toolbar" aria-label="Actions and abilities">
            {tools.map((t) => (
              <button
                key={t.id}
                type="button"
                className="ability"
                disabled={!!t.blocked}
                aria-pressed={tool === t.id}
                aria-label={`${ABILITY_INFO[t.id].label}${t.cost !== undefined ? `, costs ${t.cost} points` : ''}. ${t.blocked ?? 'Ready'}`}
                onClick={() => {
                  setError(null);
                  setTool(t.id);
                }}
              >
                <span className="a-top">
                  <span className="a-name">{ABILITY_INFO[t.id].label}</span>
                  <span className="a-cost">{t.cost !== undefined ? `${t.cost} pts` : 'Free'}</span>
                </span>
                <span className="a-desc">{ABILITY_INFO[t.id].desc}</span>
                <span className={`a-state ${t.blocked ? 'blocked' : 'ready'}`}>{t.blocked ?? (tool === t.id ? 'Selected' : 'Ready')}</span>
              </button>
            ))}
            <button type="button" className="ability" aria-pressed={tool === 'predict'} onClick={() => setTool('predict')} aria-label="Predict: private markers, no effect on the game">
              <span className="a-top">
                <span className="a-name">Predict</span>
                <span className="a-cost">Free</span>
              </span>
              <span className="a-desc">Private markers, no game effect</span>
              <span className="a-state ready">{tool === 'predict' ? 'Selected' : 'Always'}</span>
            </button>
          </div>
          {tool === 'airstrike' && myTurn && (
            <div className="row">
              <span className="small muted">Airstrike axis</span>
              <button type="button" className="btn sm" aria-pressed={axis === 'row'} onClick={() => setAxis('row')}>Row ↔</button>
              <button type="button" className="btn sm" aria-pressed={axis === 'col'} onClick={() => setAxis('col')}>Column ↕</button>
            </div>
          )}
        </div>
      )}

      {mineMode && (
        <div className="mode-banner" role="status">
          <span>
            <strong>Mine placement</strong> · choose empty water on <b>your own board</b> ({costs.mine} pts). Press Esc to cancel.
          </span>
          <button className="btn sm" type="button" onClick={() => (setTool(defaultTool), setError(null))}>Cancel</button>
        </div>
      )}
      {error && <div className="banner bad" role="alert">{error}</div>}
      {feedback && !error && <div className="feedback" aria-live="polite">Last action: {feedback}</div>}

      <div className="combat">
        <div className="combat-main">{mineMode ? ownPanel('primary') : enemyPanel('primary')}</div>
        <aside className="combat-side">
          {mineMode ? enemyPanel('secondary') : ownPanel('secondary')}
          <div className="statgrid">
            <div className="stat"><b>{me.balance}</b><span>{spectator ? me.name : 'Your'} balance</span></div>
            <div className="stat"><b>{me.score}</b><span>{spectator ? me.name : 'Your'} score</span></div>
            <div className="stat"><b>{opp.balance}</b><span>{opp.name} balance</span></div>
            <div className="stat"><b>{opp.score}</b><span>{opp.name} score</span></div>
          </div>
          {aiReasoning && aiReasoning.length > 0 && (
            <div className="reasoning" aria-label="AI reasoning">
              <h3 style={{ marginBottom: 6 }}>AI inference</h3>
              {aiReasoning.map((r, i) => <div key={i}>› {r}</div>)}
            </div>
          )}
          {extraSide}
          <div className="panel tight stack">
            <div className="row spread">
              <h3>Enemy fleet</h3>
              {!spectator && predictions.size > 0 && (
                <button type="button" className="btn ghost sm" onClick={clearPredictions}>Clear {predictions.size} marker(s)</button>
              )}
            </div>
            <div className="fleet-list">{fleetStatus(enemyBoard)}</div>
          </div>
          <div className="panel tight stack">
            <h3>Battle log</h3>
            <div className="log" aria-live="polite">
              {log.map((l, i) => <div key={i} className={l.cls}>{l.text}</div>)}
            </div>
          </div>
          <div className="legend" aria-hidden>
            <span><i className="cell hit" /> hit</span>
            <span><i className="cell miss" /> miss</span>
            <span><i className="cell sunk-enemy" /> sunk</span>
            <span><i className="cell radar-ship" /> radar contact</span>
            <span><i className="cell mine-active" /> mine</span>
            <span><i className="cell predict" /> marker</span>
          </div>
        </aside>
      </div>
    </div>
  );
}
