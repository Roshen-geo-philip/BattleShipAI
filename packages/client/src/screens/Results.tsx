export interface ResultPlayer {
  id: string;
  name: string;
  balance: number;
  score: number;
  shipsSunk: number;
  hits: number;
  misses: number;
  shipsLost: number;
}

export function BattleResults({
  winnerId,
  players,
  onAgain,
  onExit,
  againLabel = 'Play again',
}: {
  names: Record<string, string>;
  winnerId: string;
  players: ResultPlayer[];
  onAgain?: () => void;
  onExit?: () => void;
  againLabel?: string;
}) {
  const winner = players.find((p) => p.id === winnerId);
  return (
    <div className="panel stack" role="region" aria-label="Battle results">
      <div className="row spread">
        <h2>🏆 {winner?.name} won the battle</h2>
        <div className="row">
          {onAgain && <button className="btn primary" type="button" onClick={onAgain}>{againLabel}</button>}
          {onExit && <button className="btn" type="button" onClick={onExit}>Main menu</button>}
        </div>
      </div>
      <table className="tbl">
        <thead>
          <tr><th>Player</th><th>Score</th><th>Balance</th><th>Ships sunk</th><th>Hits</th><th>Misses</th><th>Accuracy</th></tr>
        </thead>
        <tbody>
          {players.map((p) => (
            <tr key={p.id} className={p.id === winnerId ? 'current' : ''}>
              <td>{p.id === winnerId ? '🏆 ' : ''}{p.name}</td>
              <td>{p.score}</td>
              <td>{p.balance}</td>
              <td>{p.shipsSunk}</td>
              <td>{p.hits}</td>
              <td>{p.misses}</td>
              <td>{p.hits + p.misses ? Math.round((100 * p.hits) / (p.hits + p.misses)) : 0}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
