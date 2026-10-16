import type { Coord, Orientation } from './types';

export interface ShipTemplate {
  id: string;
  name: string;
  /** Occupied cells in the 'horizontal' orientation, as [x, y] offsets from the top-left. */
  pattern: [number, number][];
  size: number;
  allowedOrientations: Orientation[];
  /** Visual representation used by the UI. */
  visual: { color: string; glyph: string; description: string };
}

/**
 * Rotation rule: 'vertical' is the horizontal pattern rotated 90° clockwise
 * (x, y) -> (maxY - y, x), then normalised so the bounding box starts at (0, 0).
 * Templates that are identical under rotation only list 'horizontal'.
 */
export const SHIP_CATALOG: readonly ShipTemplate[] = [
  {
    id: 'patrol',
    name: 'Patrol Boat',
    pattern: [[0, 0], [1, 0]],
    size: 2,
    allowedOrientations: ['horizontal', 'vertical'],
    visual: { color: '#7dd3fc', glyph: '▬', description: 'Straight, 2 cells' },
  },
  {
    id: 'destroyer',
    name: 'Destroyer',
    pattern: [[0, 0], [1, 0], [2, 0]],
    size: 3,
    allowedOrientations: ['horizontal', 'vertical'],
    visual: { color: '#38bdf8', glyph: '▬', description: 'Straight, 3 cells' },
  },
  {
    id: 'battleship',
    name: 'Battleship',
    pattern: [[0, 0], [1, 0], [2, 0], [3, 0]],
    size: 4,
    allowedOrientations: ['horizontal', 'vertical'],
    visual: { color: '#0ea5e9', glyph: '▬', description: 'Straight, 4 cells' },
  },
  {
    id: 'carrier',
    name: 'Aircraft Carrier',
    pattern: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
    size: 5,
    allowedOrientations: ['horizontal', 'vertical'],
    visual: { color: '#0284c7', glyph: '▬', description: 'Straight, 5 cells' },
  },
  {
    id: 'corvette',
    name: 'Corvette',
    pattern: [[0, 0], [1, 0], [0, 1]],
    size: 3,
    allowedOrientations: ['horizontal', 'vertical'],
    visual: { color: '#a7f3d0', glyph: '◣', description: 'Small L, 3 cells' },
  },
  {
    id: 'frigate',
    name: 'Frigate',
    pattern: [[0, 0], [1, 0], [2, 0], [2, 1]],
    size: 4,
    allowedOrientations: ['horizontal', 'vertical'],
    visual: { color: '#34d399', glyph: '┐', description: 'L-shape, 4 cells' },
  },
  {
    id: 'cruiser',
    name: 'Cruiser',
    pattern: [[0, 0], [1, 0], [2, 0], [1, 1]],
    size: 4,
    allowedOrientations: ['horizontal', 'vertical'],
    visual: { color: '#fbbf24', glyph: '┬', description: 'T-shape, 4 cells' },
  },
  {
    id: 'submarine',
    name: 'Submarine',
    pattern: [[0, 0], [1, 0], [1, 1], [2, 1]],
    size: 4,
    allowedOrientations: ['horizontal', 'vertical'],
    visual: { color: '#a78bfa', glyph: '⌐', description: 'Z-shape, 4 cells' },
  },
  {
    id: 'hovercraft',
    name: 'Hovercraft',
    pattern: [[0, 0], [1, 0], [0, 1], [1, 1]],
    size: 4,
    allowedOrientations: ['horizontal'],
    visual: { color: '#f472b6', glyph: '■', description: 'Square 2×2, 4 cells' },
  },
  {
    id: 'fortress',
    name: 'Sea Fortress',
    pattern: [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],
    size: 5,
    allowedOrientations: ['horizontal'],
    visual: { color: '#fb7185', glyph: '✚', description: 'Plus-shape, 5 cells' },
  },
];

const byId = new Map(SHIP_CATALOG.map((t) => [t.id, t]));

export function getTemplate(id: string): ShipTemplate {
  const t = byId.get(id);
  if (!t) throw new Error(`Unknown ship template: ${id}`);
  return t;
}

export function hasTemplate(id: string): boolean {
  return byId.has(id);
}

function normalise(cells: [number, number][]): Coord[] {
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  return cells
    .map(([x, y]) => ({ x: x - minX, y: y - minY }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Oriented offsets (relative to the top-left of the bounding box). */
export function orientedPattern(template: ShipTemplate, orientation: Orientation): Coord[] {
  if (orientation === 'horizontal') return normalise(template.pattern);
  const maxY = Math.max(...template.pattern.map((c) => c[1]));
  return normalise(template.pattern.map(([x, y]) => [maxY - y, x]));
}

export function patternBounds(cells: Coord[]): { width: number; height: number } {
  return {
    width: Math.max(...cells.map((c) => c.x)) + 1,
    height: Math.max(...cells.map((c) => c.y)) + 1,
  };
}
