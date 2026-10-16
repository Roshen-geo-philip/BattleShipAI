import { useRef, useState, type CSSProperties, type ReactNode } from 'react';

export interface CellInfo {
  cls?: string;
  label?: string;
  style?: CSSProperties;
  content?: ReactNode;
}

interface Props {
  size: number;
  ariaLabel: string;
  cell: (x: number, y: number) => CellInfo;
  onCellClick?: (x: number, y: number) => void;
  onCellHover?: (cell: { x: number; y: number } | null) => void;
  disabled?: boolean;
}

export const colName = (x: number) => String.fromCharCode(65 + x);
export const coordName = (x: number, y: number) => `${colName(x)}${y + 1}`;

/** Accessible grid: one tab stop, arrow keys to move, Enter/Space to act. */
export function Board({ size, ariaLabel, cell, onCellClick, onCellHover, disabled }: Props) {
  const [focus, setFocus] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);

  const move = (dx: number, dy: number) => {
    const nx = Math.max(0, Math.min(size - 1, focus.x + dx));
    const ny = Math.max(0, Math.min(size - 1, focus.y + dy));
    setFocus({ x: nx, y: ny });
    onCellHover?.({ x: nx, y: ny });
    ref.current?.querySelector<HTMLButtonElement>(`[data-c="${nx},${ny}"]`)?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    const map: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (map[e.key]) {
      e.preventDefault();
      move(...map[e.key]);
    }
  };

  const items: ReactNode[] = [<div key="corner" className="axis top" />];
  for (let x = 0; x < size; x++) items.push(<div key={`c${x}`} className="axis top" aria-hidden>{colName(x)}</div>);
  for (let y = 0; y < size; y++) {
    items.push(<div key={`r${y}`} className="axis" aria-hidden>{y + 1}</div>);
    for (let x = 0; x < size; x++) {
      const info = cell(x, y);
      const isFocus = focus.x === x && focus.y === y;
      items.push(
        <button
          key={`${x},${y}`}
          data-c={`${x},${y}`}
          type="button"
          role="gridcell"
          className={`cell ${info.cls ?? ''}`}
          style={info.style}
          tabIndex={isFocus ? 0 : -1}
          aria-label={`${coordName(x, y)}: ${info.label ?? 'water'}`}
          aria-disabled={disabled || undefined}
          onClick={() => {
            setFocus({ x, y });
            if (!disabled) onCellClick?.(x, y);
          }}
          onMouseEnter={() => onCellHover?.({ x, y })}
          onFocus={() => onCellHover?.({ x, y })}
        >
          {info.content}
        </button>,
      );
    }
  }

  return (
    <div
      ref={ref}
      role="grid"
      aria-label={ariaLabel}
      className={`board has-top ${disabled ? 'disabled' : ''}`}
      style={{ ['--n' as string]: size, ['--cellmax' as string]: size <= 5 ? '58px' : '32px' }}
      onKeyDown={onKey}
      onMouseLeave={() => onCellHover?.(null)}
    >
      {items}
    </div>
  );
}

export function ShipMini({ cells, color }: { cells: { x: number; y: number }[]; color: string }) {
  const w = Math.max(...cells.map((c) => c.x)) + 1;
  const h = Math.max(...cells.map((c) => c.y)) + 1;
  const set = new Set(cells.map((c) => `${c.x},${c.y}`));
  const out: ReactNode[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push(<i key={`${x},${y}`} style={{ background: set.has(`${x},${y}`) ? color : 'transparent' }} />);
  return (
    <span className="mini" style={{ gridTemplateColumns: `repeat(${w}, 9px)` }} aria-hidden>
      {out}
    </span>
  );
}
