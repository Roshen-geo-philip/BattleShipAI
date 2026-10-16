import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
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
  return { predictions: set, toggle, clear: () => (setSet(new Set()), localStorage.removeItem(storageKey)) };
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
      return { text: `💥 Mine! ${name(e.attackerId)} −1, ${name(e.ownerId)} +3`, cls: 'l-mine' };
    case 'radar':
      return { text: `${name(e.attackerId)} ran a radar sweep at ${coordName(e.x, e.y)}`, cls: 'l-radar' };
    case 'purchase':
      return e.ability === 'mine' ? { text: `${name(e.playerId)} laid a hidden mine (−${e.cost})`, cls: 'l-mine' } : null;
    case 'manual-locked':
      return { text: `${name(e.playerId)} missed — manual fire locked for the turn`, cls: '' };
    case 'turn-ended':
      return { text: `Turn ${e.turn}: ${name(e.nextPlayerId)} to move`, cls: '' };
    case 'battle-finished':
      return { text: `🏁 ${name(e.winnerId)} ${name(e.winnerId) === 'You' ? 'win' : 'wins'} (${e.reason === 'forfeit' ? 'forfeit' : 'all ships sunk'})`, cls: 'l-sunk' };
    default:
      return null;
  }
}

export function Combat({ view, meId, canAct, send, timer, aiReasoning, spectator, extraSide }: Props) {
  const oppId = view.playerOrder.find((p) => p !== meId)!;
  const me = view.players[meId];
  const opp = view.players[oppId];
  const myTurn = view.phase === 'active' && view.turn?.playerId === meId && canAct && !spectator;
  const locked = !!view.turn?.manualLocked;
  const costs = view.rules.abilityCosts;
  const [tool, setTool] = useState<Tool>('attack');
  const [axis, setAxis] = useState<'row' | 'col'>('row');
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Map<string, string>>(new Map());
  const { predictions, toggle: togglePrediction, clear: clearPredictions } = usePredictions(`bs:pred:${view.id}:${meId}`);
  const seen = useRef<Set<string> | null>(null);
  const names = (id: string) => (id === meId && !spectator ? 'You' : view.players[id]?.name ?? '?');

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
    const t = setTimeout(() => setFlash(new Map()), 1000);
    return () => clearTimeout(t);
  }, [view.log, meId, oppId]);

  useEffect(() => {
    if (locked && tool === 'attack') setTool('predict');
    if (!locked && tool === 'predict' && myTurn) setTool('attack');
  }, [locked, myTurn]); // eslint-disable-line react-hooks/exhaustive-deps

  const fire = async (a: ActionInput) => {
    setError(null);
    const res = await send(a);
    if (!res.ok) setError(res.error ?? 'Action rejected');
    else if (a.type !== 'attack' && a.type !== 'endTurn') setTool(locked ? 'predict' : 'attack');
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

  const clickEnemy = (x: number, y: number) => {
    if (tool === 'predict' || !myTurn) {
      if (!view.boards[oppId].shots.some((s) => s.x === x && s.y === y)) togglePrediction(key(x, y));
      return;
    }
    const n = view.size;
    if (tool === 'attack') fire({ type: 'attack', x, y });
    else if (tool === 'airstrike') fire({ type: 'airstrike', axis, index: axis === 'row' ? y : x });
    else if (tool === 'nuke') fire({ type: 'nuke', x: Math.min(x, n - 2), y: Math.min(y, n - 2) });
    else if (tool === 'radar') fire({ type: 'radar', x, y });
  };

  const clickOwn = (x: number, y: number) => {
    if (tool === 'mine' && myTurn) fire({ type: 'placeMine', x, y });
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
      if (viewerSide && targetArea.has(k) && (myTurn || tool === 'predict')) cls.push('target');
      if (viewerSide && myTurn && tool === 'attack' && (locked || shot)) cls.push('locked');
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
      if (tool === 'mine' && myTurn && hover && hover.x === x && hover.y === y) cls.push(s || m || shot ? 'preview-bad' : 'preview-ok');
      const fl = flash.get(`${board.ownerId}:${k}`);
      if (fl) cls.push(fl);
      return { cls: cls.join(' '), label, style };
    };
  };

  const enemyBoard = view.boards[oppId];
  const myBoard = view.boards[meId];

  const abilityDisabled = (a: AbilityId): string | null => {
    if (!myTurn) return 'Not your turn';
    if (locked && !view.rules.allowAbilitiesAfterMiss) return 'Disabled after a miss';
    if ((view.turn?.abilitiesUsed ?? 0) > 0 && !view.rules.allowMultipleAbilitiesPerTurn) return 'One ability per turn';
    if (a === 'mine' && !view.rules.allowMinesInTurn) return 'Mines only during setup';
    if (me.balance < costs[a]) return `Need ${costs[a]} points`;
    return null;
  };

  const tools: { id: Tool; label: string; icon: string; cost?: number; disabled: string | null }[] = [
    { id: 'attack', label: 'Fire', icon: '🎯', disabled: !myTurn ? 'Not your turn' : locked ? 'Locked after a miss' : null },
    { id: 'airstrike', label: 'Airstrike', icon: '✈', cost: costs.airstrike, disabled: abilityDisabled('airstrike') },
    { id: 'nuke', label: 'Nuke', icon: '☢', cost: costs.nuke, disabled: abilityDisabled('nuke') },
    { id: 'radar', label: 'Radar', icon: '📡', cost: costs.radar, disabled: abilityDisabled('radar') },
    { id: 'mine', label: 'Mine', icon: '✹', cost: costs.mine, disabled: abilityDisabled('mine') },
    { id: 'predict', label: 'Predict', icon: '⚑', disabled: null },
  ];

  const turnName = view.turn ? names(view.turn.playerId) : '';
  const log = view.log.map((e) => describeEvent(e, names)).filter(Boolean).slice(-14).reverse() as { text: string; cls: string }[];
  const fleetStatus = (board: BoardView) =>
    view.templateIds.map((t) => {
      const sunk = board.ships.some((s) => s.templateId === t && s.sunk);
      const tpl = getTemplate(t);
      return (
        <div key={t} className={`ship-row ${sunk ? 'sunk' : ''}`}>
          <ShipMini cells={tpl.pattern.map(([x, y]) => ({ x, y }))} color={sunk ? '#7f1d1d' : tpl.visual.color} />
          {tpl.name}
        </div>
      );
    });

  return (
    <div className="stack">
      <div className="row spread">
        <div className="row">
          {view.phase === 'finished' ? (
            <div className="banner ok">🏁 {names(view.winnerId!)} {view.winnerId === meId && !spectator ? 'win' : 'wins'} this battle</div>
          ) : myTurn ? (
            <div className="banner turn" role="status">🎯 Your turn {locked && '· manual fire locked (missed) — use an ability or End Turn'}</div>
          ) : (
            <div className="banner" role="status">⏳ {turnName}'s turn{locked ? ' (missed)' : ''}</div>
          )}
          <span className="pill">Turn {view.turn?.number ?? '–'}</span>
        </div>
        <Countdown timer={view.phase === 'active' ? timer : null} />
      </div>

      {!spectator && (
        <div className="row spread">
          <div className="toolbar" role="toolbar" aria-label="Actions">
            {tools.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`btn tool ${tool === t.id ? 'active' : ''}`}
                disabled={!!t.disabled && t.id !== 'predict'}
                title={t.disabled ?? undefined}
                aria-pressed={tool === t.id}
                onClick={() => setTool(t.id)}
              >
                <span>{t.icon} {t.label}</span>
                {t.cost !== undefined && <span className="cost">{t.cost} pts</span>}
              </button>
            ))}
            {tool === 'airstrike' && (
              <button type="button" className="btn" onClick={() => setAxis(axis === 'row' ? 'col' : 'row')}>
                Axis: {axis === 'row' ? 'Row ↔' : 'Column ↕'}
              </button>
            )}
          </div>
          <button className="btn primary big" type="button" disabled={!myTurn} onClick={() => fire({ type: 'endTurn' })}>
            End Turn ⏭
          </button>
        </div>
      )}
      {error && <div className="banner bad" role="alert">{error}</div>}

      <div className="combat">
        <div className="board-wrap">
          <div className="board-title">
            <h2>{spectator ? `${opp.name}'s waters` : 'Enemy waters'}</h2>
            <span className="muted small">
              {opp.name} · {enemyBoard.shipsRemaining} ships left
            </span>
          </div>
          <Board
            size={view.size}
            ariaLabel={`${opp.name}'s board`}
            cell={enemyCell(enemyBoard, !spectator)}
            onCellClick={spectator ? undefined : clickEnemy}
            onCellHover={setHover}
            disabled={spectator}
          />
          <p className="muted small" aria-live="polite">
            {hover ? `${coordName(hover.x, hover.y)}` : '—'}
            {tool === 'airstrike' && hover ? ` · ${axis === 'row' ? `row ${hover.y + 1}` : `column ${colName(hover.x)}`}` : ''}
            {tool === 'predict' ? ' · click to mark predicted ship cells (private, no effect on scoring)' : ''}
          </p>
        </div>
        <div className="board-wrap">
          <div className="board-title">
            <h2>{spectator ? `${me.name}'s waters` : 'Your fleet'}</h2>
            <span className="muted small">{myBoard.shipsRemaining} ships afloat</span>
          </div>
          <Board
            size={view.size}
            ariaLabel={spectator ? `${me.name}'s board` : 'Your board'}
            cell={myBoard.revealed ? ownCell(myBoard) : enemyCell(myBoard, false)}
            onCellClick={clickOwn}
            onCellHover={tool === 'mine' ? setHover : undefined}
            disabled={spectator || tool !== 'mine'}
          />
          <div className="legend" aria-hidden>
            <span><i className="cell hit" /> hit</span>
            <span><i className="cell miss" /> miss</span>
            <span><i className="cell sunk-enemy" /> sunk</span>
            <span><i className="cell radar-ship" /> radar contact</span>
            <span><i className="cell mine-active" /> mine</span>
            <span><i className="cell predict" /> prediction</span>
          </div>
        </div>
        <aside className="stack">
          <div className="panel stack">
            <div className="statgrid">
              <div className="stat"><b>{me.balance}</b><span>{spectator ? me.name : 'Your'} balance</span></div>
              <div className="stat"><b>{me.score}</b><span>Score</span></div>
              <div className="stat"><b>{opp.balance}</b><span>{opp.name}</span></div>
              <div className="stat"><b>{opp.score}</b><span>Opp. score</span></div>
            </div>
          </div>
          {aiReasoning && aiReasoning.length > 0 && (
            <div className="reasoning" aria-label="AI reasoning">
              <b>🧠 AI inference</b>
              {aiReasoning.map((r, i) => <div key={i}>› {r}</div>)}
            </div>
          )}
          {extraSide}
          <div className="panel stack">
            <h3>Enemy fleet</h3>
            <div className="fleet-list">{fleetStatus(enemyBoard)}</div>
            {!spectator && predictions.size > 0 && (
              <button type="button" className="btn ghost small" onClick={clearPredictions}>Clear {predictions.size} prediction(s)</button>
            )}
          </div>
          <div className="panel stack">
            <h3>Battle log</h3>
            <div className="log" aria-live="polite">
              {log.map((l, i) => <div key={i} className={l.cls}>{l.text}</div>)}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
