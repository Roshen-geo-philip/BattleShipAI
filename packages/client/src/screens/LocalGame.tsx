import { useEffect, useRef, useState } from 'react';
import {
  applyAction,
  battleStats,
  createBattle,
  newActionId,
  opponentOf,
  viewBattle,
  type BattleAction,
  type BattleState,
} from '@battleship/engine';
import { Combat } from '../components/Combat';
import { Placement } from '../components/Placement';
import type { ActionInput } from '../components/types';
import { ResultScreen } from './Results';
import { saveHistory } from '../lib/history';

interface Props {
  names: [string, string];
  onExit: () => void;
}

const create = (names: [string, string]) => createBattle({ players: [{ id: 'p1', name: names[0] || 'Player 1' }, { id: 'p2', name: names[1] || 'Player 2' }] });

/** Pass-and-play: the device is handed over behind a privacy screen whenever control changes. */
export function LocalGame({ names, onExit }: Props) {
  const [state, setState] = useState<BattleState>(() => create(names));
  const [viewer, setViewer] = useState('p1');
  const [handover, setHandover] = useState<string | null>('p1');
  const ref = useRef(state);
  ref.current = state;

  const send = async (a: ActionInput) => {
    const before = ref.current;
    const r = applyAction(before, { ...a, playerId: viewer, actionId: newActionId('l') } as BattleAction);
    if (!r.ok) return { ok: false, error: r.error };
    ref.current = r.state;
    setState(r.state);
    const started = r.events.find((e) => e.kind === 'battle-started');
    if (started && started.kind === 'battle-started') {
      setHandover(started.firstPlayerId);
    } else if (a.type === 'ready' && r.state.phase === 'setup') {
      setHandover(opponentOf(r.state, viewer));
    } else if (a.type === 'endTurn' && r.state.phase === 'active') {
      setHandover(r.state.turn!.playerId);
    }
    return { ok: true };
  };

  useEffect(() => {
    if (state.phase !== 'finished') return;
    saveHistory({
      id: state.id,
      at: Date.now(),
      mode: 'Local PNP',
      summary: `${state.players.p1.name} vs ${state.players.p2.name}`,
      winner: state.players[state.winnerId!].name,
      scores: state.playerOrder.map((id) => ({ name: state.players[id].name, score: state.players[id].score })),
    });
  }, [state.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  if (handover) {
    const who = state.players[handover].name;
    return (
      <div className="handover">
        <div className="panel stack" role="dialog" aria-modal="true" aria-labelledby="handover-title">
          <div className="m-stripe short" />
          <span className="caption">Privacy screen</span>
          <h2 id="handover-title">Pass the device to {who}</h2>
          <p className="muted">
            {state.phase === 'setup' ? `${who}, it's time to deploy your fleet.` : `${who}, it's your turn.`} Everyone else, look away — boards are hidden until{' '}
            {who} continues.
          </p>
          <button
            className="btn solid big"
            type="button"
            autoFocus
            onClick={() => {
              setViewer(handover);
              setHandover(null);
            }}
          >
            I'm {who} — show my board
          </button>
        </div>
      </div>
    );
  }

  const view = viewBattle(state, viewer);
  if (state.phase === 'setup') return <Placement view={view} meId={viewer} send={send} title={`${state.players[viewer].name}: deploy your fleet`} />;
  return (
    <div className="stack">
      {state.phase === 'finished' && (
        <ResultScreen
          outcome="victory"
          kicker="Local PNP · match complete"
          winnerLine={`${state.players[state.winnerId!].name} wins — ${state.players[opponentOf(state, state.winnerId!)].name}'s fleet is ${state.endReason === 'forfeit' ? 'withdrawn' : 'sunk'}.`}
          scores={state.playerOrder.map((id) => ({ label: state.players[id].name, value: state.players[id].score }))}
          summary={[`Turns played: ${state.turn?.number ?? 0}`]}
          players={state.playerOrder.map((id) => ({ ...state.players[id], ...battleStats(state, id) }))}
          winnerId={state.winnerId}
          onAgain={() => {
            const s = create(names);
            ref.current = s;
            setState(s);
            setViewer('p1');
            setHandover('p1');
          }}
          againLabel="Rematch"
          onMenu={onExit}
        />
      )}
      <Combat view={view} meId={viewer} canAct={state.phase === 'active'} send={send} />
    </div>
  );
}
