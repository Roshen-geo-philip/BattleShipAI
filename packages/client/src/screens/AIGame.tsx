import { useEffect, useRef, useState } from 'react';
import {
  BattleshipAI,
  applyAction,
  battleStats,
  createBattle,
  newActionId,
  randomSeed,
  viewBattle,
  type BattleAction,
  type BattleState,
  type Difficulty,
} from '@battleship/engine';
import { Combat } from '../components/Combat';
import { Placement } from '../components/Placement';
import type { ActionInput } from '../components/types';
import { BattleResults } from './Results';
import { saveHistory } from '../lib/history';

const HUMAN = 'you';
const AI = 'ai';

interface Game {
  ai: BattleshipAI;
  state: BattleState;
}

function newGame(name: string, difficulty: Difficulty): Game {
  const seed = randomSeed();
  const ai = new BattleshipAI(AI, 15, difficulty, seed ^ 0x5bd1e995);
  let state = createBattle({
    players: [{ id: HUMAN, name: name || 'You' }, { id: AI, name: `FOPC AI (${difficulty})`, isAI: true }],
    size: 15,
    seed,
  });
  // The AI deploys through the same engine actions as a human.
  for (const a of ai.planSetup(viewBattle(state, AI))) {
    const r = applyAction(state, a);
    if (r.ok) state = r.state;
  }
  return { ai, state };
}

export function AIGame({ name, difficulty, onExit }: { name: string; difficulty: Difficulty; onExit: () => void }) {
  const [game, setGame] = useState<Game>(() => newGame(name, difficulty));
  const [reasoning, setReasoning] = useState<string[]>([]);
  const stateRef = useRef(game.state);
  stateRef.current = game.state;
  const { state, ai } = game;

  const commit = (s: BattleState) => {
    stateRef.current = s;
    setGame((g) => ({ ...g, state: s }));
  };

  const send = async (a: ActionInput) => {
    const r = applyAction(stateRef.current, { ...a, playerId: HUMAN, actionId: newActionId('h') } as BattleAction);
    if (!r.ok) return { ok: false, error: r.error };
    commit(r.state);
    return { ok: true };
  };

  // AI turn loop: one decision per tick so the player can follow its reasoning.
  useEffect(() => {
    if (state.phase !== 'active' || state.turn?.playerId !== AI) return;
    const t = setTimeout(() => {
      const current = stateRef.current;
      const decision = ai.decide(viewBattle(current, AI)); // AI sees only its legitimate view
      if (!decision) return;
      setReasoning(decision.reasoning);
      const r = applyAction(current, decision.action);
      if (r.ok) commit(r.state);
      else {
        const end = applyAction(current, { type: 'endTurn', actionId: newActionId('ai-fallback'), playerId: AI });
        if (end.ok) commit(end.state);
      }
    }, 650);
    return () => clearTimeout(t);
  }, [state, ai]);

  useEffect(() => {
    if (state.phase !== 'finished') return;
    saveHistory({
      id: state.id,
      at: Date.now(),
      mode: `AI (${difficulty})`,
      summary: `${state.players[HUMAN].name} vs ${state.players[AI].name}`,
      winner: state.players[state.winnerId!].name,
      scores: state.playerOrder.map((id) => ({ name: state.players[id].name, score: state.players[id].score })),
    });
  }, [state.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const view = viewBattle(state, HUMAN);
  const restart = () => {
    setReasoning([]);
    setGame(newGame(name, difficulty));
  };

  if (state.phase === 'setup') return <Placement view={view} meId={HUMAN} send={send} title="Deploy against the AI" />;
  return (
    <div className="stack">
      {state.phase === 'finished' && (
        <BattleResults
          names={Object.fromEntries(state.playerOrder.map((id) => [id, state.players[id].name]))}
          winnerId={state.winnerId!}
          players={state.playerOrder.map((id) => ({ ...state.players[id], ...battleStats(state, id) }))}
          onAgain={restart}
          onExit={onExit}
        />
      )}
      <Combat view={view} meId={HUMAN} canAct={state.phase === 'active'} send={send} aiReasoning={reasoning} />
    </div>
  );
}
