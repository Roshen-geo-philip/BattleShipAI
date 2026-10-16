/**
 * A small, executable first-order logic engine.
 *
 *  - Facts are ground atoms:            Hit(3,4)
 *  - Rules are Horn clauses:            Hit(?x,?y) ∧ ¬Resolved(?x,?y) → OpenHit(?x,?y)
 *  - Variables are strings starting with '?'.
 *  - Negation is negation-as-failure, made safe by stratification (rules are
 *    evaluated stratum by stratum, each to a fixpoint).
 *  - Built-in predicates (e.g. Adjacent, Cell) are computed rather than stored.
 */

export type Term = string | number;
export type Bindings = Readonly<Record<string, Term>>;

export interface Atom {
  pred: string;
  args: Term[];
}

export interface Literal {
  atom: Atom;
  negated?: boolean;
}

export interface Rule {
  name: string;
  /** Human-readable FOPC form, shown in the AI reasoning panel. */
  text: string;
  body: Literal[];
  head: Atom;
  stratum: number;
}

/** Built-in: given args (some bound), yield extended bindings. */
export type Builtin = (args: Term[], bindings: Bindings) => Iterable<Bindings>;

export const atom = (pred: string, ...args: Term[]): Atom => ({ pred, args });
export const pos = (pred: string, ...args: Term[]): Literal => ({ atom: atom(pred, ...args) });
export const neg = (pred: string, ...args: Term[]): Literal => ({ atom: atom(pred, ...args), negated: true });

export const isVar = (t: Term): t is string => typeof t === 'string' && t.startsWith('?');

export function substitute(t: Term, b: Bindings): Term {
  return isVar(t) && t in b ? b[t] : t;
}

const factKey = (pred: string, args: Term[]) => `${pred}(${args.join(',')})`;

/** Unify a pattern (with variables) against ground args. */
export function unify(pattern: Term[], ground: Term[], b: Bindings): Bindings | null {
  if (pattern.length !== ground.length) return null;
  let out: Record<string, Term> | null = null;
  for (let i = 0; i < pattern.length; i++) {
    const p = substitute(pattern[i], out ?? b);
    if (isVar(p)) {
      out = out ?? { ...b };
      out[p] = ground[i];
    } else if (p !== ground[i]) {
      return null;
    }
  }
  return out ?? b;
}

export class KnowledgeBase {
  private facts = new Map<string, Map<string, Term[]>>();
  private builtins = new Map<string, Builtin>();
  /** How many facts each rule derived in the last forward-chaining run. */
  readonly trace = new Map<string, number>();

  defineBuiltin(pred: string, fn: Builtin) {
    this.builtins.set(pred, fn);
  }

  assert(pred: string, ...args: Term[]): boolean {
    if (this.builtins.has(pred)) throw new Error(`Cannot assert built-in ${pred}`);
    let table = this.facts.get(pred);
    if (!table) this.facts.set(pred, (table = new Map()));
    const k = factKey(pred, args);
    if (table.has(k)) return false;
    table.set(k, args);
    return true;
  }

  retract(pred: string, ...args: Term[]): boolean {
    return this.facts.get(pred)?.delete(factKey(pred, args)) ?? false;
  }

  retractAll(pred: string) {
    this.facts.delete(pred);
  }

  holds(pred: string, ...args: Term[]): boolean {
    const bi = this.builtins.get(pred);
    if (bi) {
      for (const _ of bi(args, {})) return true;
      return false;
    }
    return this.facts.get(pred)?.has(factKey(pred, args)) ?? false;
  }

  all(pred: string): Term[][] {
    return [...(this.facts.get(pred)?.values() ?? [])];
  }

  count(pred: string): number {
    return this.facts.get(pred)?.size ?? 0;
  }

  predicates(): string[] {
    return [...this.facts.keys()];
  }

  /** Enumerate bindings satisfying one positive atom. */
  *match(a: Atom, b: Bindings): Iterable<Bindings> {
    const args = a.args.map((t) => substitute(t, b));
    const bi = this.builtins.get(a.pred);
    if (bi) {
      yield* bi(args, b);
      return;
    }
    const table = this.facts.get(a.pred);
    if (!table) return;
    if (!args.some(isVar)) {
      // Ground lookup is O(1).
      if (table.has(factKey(a.pred, args))) yield b;
      return;
    }
    for (const ground of table.values()) {
      const r = unify(args, ground, b);
      if (r) yield r;
    }
  }

  /** Solve a conjunction of literals (left to right). */
  *solve(body: Literal[], b: Bindings = {}, i = 0): Iterable<Bindings> {
    if (i === body.length) {
      yield b;
      return;
    }
    const lit = body[i];
    if (lit.negated) {
      const ground = lit.atom.args.map((t) => substitute(t, b));
      if (ground.some(isVar)) throw new Error(`Unsafe negation in ${lit.atom.pred}: unbound variable`);
      if (!this.holds(lit.atom.pred, ...ground)) yield* this.solve(body, b, i + 1);
      return;
    }
    for (const nb of this.match(lit.atom, b)) yield* this.solve(body, nb, i + 1);
  }

  query(body: Literal[]): Bindings[] {
    return [...this.solve(body)];
  }

  /** Stratified forward chaining to a fixpoint. Returns number of new facts. */
  forwardChain(rules: Rule[]): number {
    this.trace.clear();
    let total = 0;
    const strata = [...new Set(rules.map((r) => r.stratum))].sort((a, b) => a - b);
    for (const stratum of strata) {
      const layer = rules.filter((r) => r.stratum === stratum);
      let changed = true;
      while (changed) {
        changed = false;
        for (const rule of layer) {
          const derived: Term[][] = [];
          for (const b of this.solve(rule.body)) {
            const args = rule.head.args.map((t) => substitute(t, b));
            if (args.some(isVar)) throw new Error(`Rule ${rule.name} derived a non-ground fact`);
            derived.push(args);
          }
          for (const args of derived) {
            if (this.assert(rule.head.pred, ...args)) {
              changed = true;
              total++;
              this.trace.set(rule.name, (this.trace.get(rule.name) ?? 0) + 1);
            }
          }
        }
      }
    }
    return total;
  }
}
