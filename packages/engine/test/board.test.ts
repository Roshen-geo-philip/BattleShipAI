import { describe, expect, it } from 'vitest';
import { allPlacements, placementCells, randomFleet, selectTemplates, validateFleet, validatePlacement, key } from '../src/board';
import { BOARD_CONFIG } from '../src/config';
import { createBattle } from '../src/battle';
import { createRng } from '../src/rng';
import { SHIP_CATALOG, getTemplate, orientedPattern } from '../src/ships';
import { FLEET, TEMPLATES } from './helpers';

describe('ship catalog', () => {
  it('has exactly ten unique templates with consistent sizes', () => {
    expect(SHIP_CATALOG).toHaveLength(10);
    expect(new Set(SHIP_CATALOG.map((t) => t.id)).size).toBe(10);
    for (const t of SHIP_CATALOG) {
      expect(t.pattern).toHaveLength(t.size);
      expect(t.allowedOrientations.length).toBeGreaterThan(0);
      expect(new Set(t.pattern.map(([x, y]) => `${x},${y}`)).size).toBe(t.size);
    }
  });

  it('rotates patterns into vertical orientation preserving size', () => {
    const v = orientedPattern(getTemplate('carrier'), 'vertical');
    expect(v).toEqual([0, 1, 2, 3, 4].map((y) => ({ x: 0, y })));
    const l = orientedPattern(getTemplate('frigate'), 'vertical');
    expect(l).toHaveLength(4);
    expect(Math.min(...l.map((c) => c.x))).toBe(0);
  });
});

describe('placement validation', () => {
  it('accepts horizontal and vertical placements inside the board', () => {
    expect(validatePlacement(15, { templateId: 'carrier', x: 10, y: 0, orientation: 'horizontal' }, new Set())).toBeNull();
    expect(validatePlacement(15, { templateId: 'carrier', x: 0, y: 10, orientation: 'vertical' }, new Set())).toBeNull();
  });

  it('rejects ships that leave the board', () => {
    expect(validatePlacement(15, { templateId: 'carrier', x: 11, y: 0, orientation: 'horizontal' }, new Set())).toMatch(/leave/);
    expect(validatePlacement(15, { templateId: 'carrier', x: 0, y: 11, orientation: 'vertical' }, new Set())).toMatch(/leave/);
    expect(validatePlacement(15, { templateId: 'patrol', x: -1, y: 0, orientation: 'horizontal' }, new Set())).toMatch(/leave/);
  });

  it('rejects overlapping ships', () => {
    const fleet = [...FLEET];
    fleet[1] = { templateId: 'destroyer', x: 0, y: 0, orientation: 'vertical' };
    expect(validateFleet(15, TEMPLATES, fleet)).toMatch(/overlap/);
  });

  it('rejects disallowed orientations, wrong fleets and duplicates', () => {
    expect(validatePlacement(15, { templateId: 'hovercraft', x: 0, y: 0, orientation: 'vertical' }, new Set())).toMatch(/cannot/);
    expect(validateFleet(15, TEMPLATES, FLEET.slice(0, 4))).toMatch(/Exactly/);
    const dup = [...FLEET.slice(0, 4), { ...FLEET[0], y: 12 }];
    expect(validateFleet(15, TEMPLATES, dup)).toMatch(/does not match/);
  });

  it('random placement always produces a valid configuration', () => {
    for (let seed = 0; seed < 200; seed++) {
      const rng = createRng(seed);
      const ids = selectTemplates(BOARD_CONFIG, rng);
      const size = BOARD_CONFIG.size;
      const fleet = randomFleet(size, ids, rng);
      expect(fleet).not.toBeNull();
      expect(validateFleet(size, ids, fleet!)).toBeNull();
    }
  });

  it('the only board is 15x15 with exactly seven distinct ships that always fit', () => {
    expect(BOARD_CONFIG).toEqual({ size: 15, shipCount: 7 });
    for (let seed = 0; seed < 100; seed++) {
      const std = selectTemplates(BOARD_CONFIG, createRng(seed));
      expect(std).toHaveLength(7);
      expect(new Set(std).size).toBe(7);
      expect(randomFleet(15, std, createRng(seed + 1))).not.toBeNull();
    }
  });

  it('default battles use seven ships and other board sizes are rejected', () => {
    const players: [{ id: string; name: string }, { id: string; name: string }] = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
    for (let seed = 0; seed < 20; seed++) expect(createBattle({ players, seed }).templateIds).toHaveLength(7);
    expect(() => createBattle({ players, size: 5 })).toThrow(/15×15/);
  });

  it('enumerates only in-bounds placements', () => {
    for (const t of SHIP_CATALOG) {
      for (const p of allPlacements(15, t.id)) {
        for (const c of placementCells(p)) {
          expect(c.x).toBeGreaterThanOrEqual(0);
          expect(c.x).toBeLessThan(15);
          expect(c.y).toBeLessThan(15);
        }
      }
    }
  });

  it('respects blocked (mine) cells during random placement', () => {
    const blocked = new Set([key(0, 0), key(1, 1), key(2, 2)]);
    const fleet = randomFleet(15, TEMPLATES, createRng(3), blocked)!;
    const cells = fleet.flatMap(placementCells).map((c) => key(c.x, c.y));
    expect(cells.some((k) => blocked.has(k))).toBe(false);
  });
});
