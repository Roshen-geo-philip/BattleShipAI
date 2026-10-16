import { useEffect, useMemo, useState } from 'react';
import {
  createRng,
  getTemplate,
  key,
  orientedPattern,
  placementCells,
  randomFleet,
  rotate,
  validatePlacement,
  type BattleView,
  type Orientation,
  type ShipPlacement,
} from '@battleship/engine';
import { Board, ShipMini, coordName } from './Board';
import { Countdown } from './Countdown';
import type { Send, TimerInfo } from './types';
import { sfx } from '../lib/sound';

interface Props {
  view: BattleView;
  meId: string;
  send: Send;
  timer?: TimerInfo | null;
  title?: string;
}

export function Placement({ view, meId, send, timer, title }: Props) {
  const me = view.players[meId];
  const myBoard = view.boards[meId];
  const opponentId = view.playerOrder.find((p) => p !== meId)!;
  const opponent = view.players[opponentId];
  const [placed, setPlaced] = useState<Record<string, ShipPlacement>>({});
  const [selected, setSelected] = useState<string | null>(view.templateIds[0]);
  const [orientation, setOrientation] = useState<Orientation>('horizontal');
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<'ship' | 'mine'>('ship');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset when a new battle starts (team rounds reuse this component).
  useEffect(() => {
    setPlaced({});
    setSelected(view.templateIds[0]);
  }, [view.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const mineCells = useMemo(() => new Set(myBoard.mines.map((m) => key(m.x, m.y))), [myBoard.mines]);

  const occupied = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of Object.values(placed)) for (const c of placementCells(p)) map.set(key(c.x, c.y), p.templateId);
    return map;
  }, [placed]);

  const allowedOrientation = (id: string, o: Orientation) => (getTemplate(id).allowedOrientations.includes(o) ? o : getTemplate(id).allowedOrientations[0]);

  const candidate: ShipPlacement | null =
    tool === 'ship' && selected && hover ? { templateId: selected, x: hover.x, y: hover.y, orientation: allowedOrientation(selected, orientation) } : null;

  const occupiedExcept = (templateId: string) => new Set([...occupied.entries()].filter(([, t]) => t !== templateId).map(([k]) => k));
  const candidateError = candidate ? validatePlacement(view.size, candidate, occupiedExcept(candidate.templateId), mineCells) : null;
  const previewCells = candidate
    ? orientedPattern(getTemplate(candidate.templateId), candidate.orientation).map((c) => key(c.x + candidate.x, c.y + candidate.y))
    : [];
  const preview = new Set(previewCells);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'r' || e.key === 'R') setOrientation((o) => rotate(o));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const locked = me.ready;

  const clickCell = async (x: number, y: number) => {
    if (locked) return;
    setMessage(null);
    const k = key(x, y);
    if (tool === 'mine') {
      if (occupied.has(k)) return setMessage('Mines must go on empty water.');
      const res = await send({ type: 'placeMine', x, y });
      if (!res.ok) setMessage(res.error ?? 'Could not place mine');
      else sfx.click();
      return;
    }
    // Clicking an already placed ship picks it up for repositioning.
    if (occupied.has(k) && (!selected || placed[selected] || occupied.get(k) !== selected)) {
      const t = occupied.get(k)!;
      const next = { ...placed };
      delete next[t];
      setPlaced(next);
      setSelected(t);
      return;
    }
    // Use the tapped cell directly (touch devices have no hover preview).
    if (!selected) return;
    const target: ShipPlacement = { templateId: selected, x, y, orientation: allowedOrientation(selected, orientation) };
    const err = validatePlacement(view.size, target, occupiedExcept(selected), mineCells);
    if (err) return setMessage(err);
    const next = { ...placed, [target.templateId]: target };
    setPlaced(next);
    sfx.click();
    setSelected(view.templateIds.find((t) => !next[t]) ?? null);
  };

  const randomize = () => {
    const fleet = randomFleet(view.size, view.templateIds, createRng(Date.now() & 0xffffffff), mineCells);
    if (!fleet) return setMessage('Could not find a random placement around your mines.');
    setPlaced(Object.fromEntries(fleet.map((p) => [p.templateId, p])));
    setSelected(null);
    setMessage(null);
  };

  const allPlaced = view.templateIds.every((t) => placed[t]);

  const confirm = async () => {
    setBusy(true);
    const res = await send({ type: 'placeShips', placements: view.templateIds.map((t) => placed[t]) });
    if (res.ok) {
      const r2 = await send({ type: 'ready' });
      if (!r2.ok) setMessage(r2.error ?? 'Could not ready up');
    } else setMessage(res.error ?? 'Placement rejected');
    setBusy(false);
  };

  const cellInfo = (x: number, y: number) => {
    const k = key(x, y);
    const cls: string[] = [];
    let label = 'water';
    const shipT = occupied.get(k);
    const style: Record<string, string> = {};
    if (shipT) {
      cls.push('ship');
      style['--ship-color'] = getTemplate(shipT).visual.color;
      label = getTemplate(shipT).name;
    }
    if (mineCells.has(k)) {
      cls.push('mine-active');
      label = 'your mine';
    }
    if (preview.has(k)) cls.push(candidateError ? 'preview-bad' : 'preview-ok');
    return { cls: cls.join(' '), label, style };
  };

  const mineCost = view.rules.abilityCosts.mine;

  return (
    <div className="stack lg">
      <div className="row spread">
        <div className="stack" style={{ gap: 8 }}>
          <span className="caption">Setup · {view.size}×{view.size} · {view.templateIds.length} ships</span>
          <h2>{title ?? 'Deploy your fleet'}</h2>
          <p className="small">
            Opponent: <b>{opponent.name}</b> {opponent.ready ? <span className="pill ok">ready</span> : <span className="pill warn">placing…</span>} · you both
            use the same {view.templateIds.length} ship shapes.
          </p>
        </div>
        <Countdown timer={timer} />
      </div>
      <div className="placement-layout">
        <div className="board-frame primary-frame board-wrap">
          <Board
            size={view.size}
            variant="placement"
            ariaLabel="Your board — placement"
            cell={cellInfo}
            onCellClick={clickCell}
            onCellHover={setHover}
            disabled={locked}
          />
          <p className="small" aria-live="polite">
            {hover ? coordName(hover.x, hover.y) : '—'} · {candidateError && candidate ? candidateError : tool === 'mine' ? `Tap empty water to lay a mine (${mineCost} pts)` : 'Tap a cell to place · tap a placed ship to move it · R rotates'}
          </p>
        </div>
        <div className="panel stack">
          <h3>Ships</h3>
          <div className="ship-picker" role="listbox" aria-label="Ships to place">
            {view.templateIds.map((id) => {
              const t = getTemplate(id);
              return (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={selected === id}
                  className={`btn ship-option ${selected === id && tool === 'ship' ? 'active' : ''} ${placed[id] ? 'placed' : ''}`}
                  onClick={() => {
                    setTool('ship');
                    setSelected(id);
                  }}
                  disabled={locked}
                >
                  <span className="row" style={{ gap: 8 }}>
                    <ShipMini cells={orientedPattern(t, allowedOrientation(id, orientation))} color={t.visual.color} />
                    {t.name}
                  </span>
                  <span className="muted small">{placed[id] ? 'Placed' : `${t.size} cells`}</span>
                </button>
              );
            })}
          </div>
          <div className="row">
            <button className="btn sm" type="button" onClick={() => setOrientation(rotate(orientation))} disabled={locked}>
              Rotate · {orientation}
            </button>
            <button className="btn sm" type="button" onClick={randomize} disabled={locked}>
              Random
            </button>
            <button className="btn ghost sm" type="button" onClick={() => (setPlaced({}), setSelected(view.templateIds[0]))} disabled={locked}>
              Clear
            </button>
          </div>
          {view.rules.allowMinesInSetup && (
            <div className="row">
              <button
                className="btn sm"
                aria-pressed={tool === 'mine'}
                type="button"
                onClick={() => setTool(tool === 'mine' ? 'ship' : 'mine')}
                disabled={locked || me.balance < mineCost}
                title={me.balance < mineCost ? 'Not enough points' : 'Place a hidden mine on your board'}
              >
                Mine · {mineCost} pts
              </button>
              <span className="muted small">Balance: {me.balance} pts · Mines: {myBoard.mines.length}</span>
            </div>
          )}
          {message && <div className="banner bad" role="alert">{message}</div>}
          {locked ? (
            <div className="stack">
              <div className="banner ok">Fleet confirmed. {opponent.ready ? 'Starting…' : `Waiting for ${opponent.name}…`}</div>
              <button className="btn block" type="button" onClick={() => send({ type: 'unready' })}>
                Change placement
              </button>
            </div>
          ) : (
            <button className="btn solid big block" type="button" disabled={!allPlaced || busy} onClick={confirm}>
              {allPlaced ? 'Confirm fleet & ready' : `Place ${view.templateIds.filter((t) => !placed[t]).length} more ship(s)`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
