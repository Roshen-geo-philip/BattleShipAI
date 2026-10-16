import type { BoardConfig } from './config';
import { type Rng, shuffle, randInt } from './rng';
import { SHIP_CATALOG, getTemplate, hasTemplate, orientedPattern, patternBounds } from './ships';
import type { Coord, Orientation, ShipPlacement } from './types';

export const key = (x: number, y: number) => `${x},${y}`;

export function inBounds(size: number, x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < size && y < size;
}

export function placementCells(p: ShipPlacement): Coord[] {
  const t = getTemplate(p.templateId);
  return orientedPattern(t, p.orientation).map((c) => ({ x: c.x + p.x, y: c.y + p.y }));
}

export function neighbours4(size: number, x: number, y: number): Coord[] {
  return [
    { x: x + 1, y },
    { x: x - 1, y },
    { x, y: y + 1 },
    { x, y: y - 1 },
  ].filter((c) => inBounds(size, c.x, c.y));
}

export type PlacementError = string | null;

/** Validate one placement against bounds, orientation rules and already-occupied cells. */
export function validatePlacement(
  size: number,
  p: ShipPlacement,
  occupied: Set<string>,
  blocked: Set<string> = new Set(),
): PlacementError {
  if (!hasTemplate(p.templateId)) return `Unknown ship ${p.templateId}`;
  const t = getTemplate(p.templateId);
  if (!t.allowedOrientations.includes(p.orientation)) return `${t.name} cannot be placed ${p.orientation}`;
  for (const c of placementCells(p)) {
    if (!inBounds(size, c.x, c.y)) return `${t.name} would leave the board`;
    if (occupied.has(key(c.x, c.y))) return `${t.name} overlaps another ship`;
    if (blocked.has(key(c.x, c.y))) return `${t.name} overlaps a mine`;
  }
  return null;
}

/** Validate a complete fleet: exactly the required templates, each once, all legal and non-overlapping. */
export function validateFleet(
  size: number,
  templateIds: string[],
  placements: ShipPlacement[],
  blocked: Set<string> = new Set(),
): PlacementError {
  if (!Array.isArray(placements) || placements.length !== templateIds.length) {
    return `Exactly ${templateIds.length} ships are required`;
  }
  if (placements.some((p) => !p || typeof p !== 'object')) return 'Invalid placement';
  const required = [...templateIds].sort();
  const given = placements.map((p) => p.templateId).sort();
  if (required.join('|') !== given.join('|')) return 'Fleet does not match the ships selected for this battle';
  const occupied = new Set<string>();
  for (const p of placements) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number') return 'Invalid coordinates';
    const err = validatePlacement(size, p, occupied, blocked);
    if (err) return err;
    for (const c of placementCells(p)) occupied.add(key(c.x, c.y));
  }
  return null;
}

/** All legal placements of one template on an empty board of the given size. */
export function allPlacements(size: number, templateId: string): ShipPlacement[] {
  const t = getTemplate(templateId);
  const out: ShipPlacement[] = [];
  for (const orientation of t.allowedOrientations) {
    const { width, height } = patternBounds(orientedPattern(t, orientation));
    for (let y = 0; y + height <= size; y++) {
      for (let x = 0; x + width <= size; x++) out.push({ templateId, x, y, orientation });
    }
  }
  return out;
}

/**
 * Random fleet placement using randomised backtracking, so it always succeeds
 * when a solution exists and returns null otherwise.
 */
export function randomFleet(
  size: number,
  templateIds: string[],
  rng: Rng,
  blocked: Set<string> = new Set(),
): ShipPlacement[] | null {
  // Place big ships first: fewer options → less backtracking.
  const order = [...templateIds].sort((a, b) => getTemplate(b).size - getTemplate(a).size);
  const occupied = new Set<string>(blocked);
  const result: ShipPlacement[] = [];
  let budget = 20000;

  const solve = (i: number): boolean => {
    if (i === order.length) return true;
    for (const p of shuffle(rng, allPlacements(size, order[i]))) {
      if (--budget < 0) return false;
      const cells = placementCells(p);
      if (cells.some((c) => occupied.has(key(c.x, c.y)))) continue;
      cells.forEach((c) => occupied.add(key(c.x, c.y)));
      result.push(p);
      if (solve(i + 1)) return true;
      result.pop();
      cells.forEach((c) => occupied.delete(key(c.x, c.y)));
    }
    return false;
  };

  return solve(0) ? result : null;
}

/**
 * Randomly choose the ship templates for a battle and prove they fit on the board
 * (by constructing a placement). Falls back to a validated straight-ship fleet.
 */
export function selectTemplates(config: BoardConfig, rng: Rng): string[] {
  const ids = SHIP_CATALOG.map((t) => t.id);
  for (let attempt = 0; attempt < 50; attempt++) {
    const chosen = shuffle(rng, ids).slice(0, config.shipCount);
    // Keep the total area reasonable so the game stays playable.
    const area = chosen.reduce((s, id) => s + getTemplate(id).size, 0);
    if (area > config.size * config.size * 0.5) continue;
    if (randomFleet(config.size, chosen, rng)) return chosen;
  }
  const fallback = ['patrol', 'destroyer', 'corvette', 'battleship', 'carrier', 'cruiser', 'frigate'].slice(0, config.shipCount);
  if (!randomFleet(config.size, fallback, rng)) throw new Error('No valid fleet for board configuration');
  return fallback;
}

export function rotate(o: Orientation): Orientation {
  return o === 'horizontal' ? 'vertical' : 'horizontal';
}

export function randomCell(size: number, rng: Rng): Coord {
  return { x: randInt(rng, size), y: randInt(rng, size) };
}
