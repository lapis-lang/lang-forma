/** Thin, type-safe wrapper around a PwZ `Exp` node. */

import {
  AltExp,
  ChainExp,
  DelayedExp,
  EmptyExp,
  EpsilonExp,
  type Exp,
  RedExp,
  SeqExp,
  type Span,
} from "./zipper.ts";

/**
 * The user-facing combinator type. Constructed by `Grammar` combinators and
 * the `@rule` decorator; users rarely call `new Parser(...)` directly.
 */
export class Parser<T> {
  /** @internal — exposes the underlying Exp to the Grammar driver. */
  readonly _exp: Exp;

  /** @internal — wrap a pre-existing `Exp`. Prefer the `Grammar` combinators. */
  constructor(exp: Exp) {
    this._exp = exp;
  }

  /* ---- semantic action ---- */

  /** Apply `fn` to every parse tree this parser produces.
   *
   * `fn` receives the parse-tree value and a `Span` describing the
   * half-open `[start, end)` character offsets in the source string.
   */
  map<U>(fn: (t: T, span: Span) => U): Parser<U> {
    return new Parser<U>(new RedExp<T, U>(this._exp, fn));
  }

  /* ---- combinators ---- */

  /** A ∪ B — succeed if either branch succeeds. */
  or<U>(other: Parser<U>): Parser<T | U> {
    const left = this._exp;
    const right = other._exp;
    if (left instanceof AltExp && right instanceof AltExp) {
      return new Parser<T | U>(
        new AltExp([...left.children, ...right.children]),
      );
    }
    if (left instanceof AltExp) {
      return new Parser<T | U>(new AltExp([...left.children, right]));
    }
    if (right instanceof AltExp) {
      return new Parser<T | U>(new AltExp([left, ...right.children]));
    }
    return new Parser<T | U>(new AltExp([left, right]));
  }

  /** A ○ B — sequence; parse trees are pairs `[T, U]`. */
  then<U>(other: Parser<U>): Parser<[T, U]> {
    return new Parser<[T, U]>(
      new SeqExp("_seq", [this._exp, other._exp], ([a, b]) => [a, b] as [T, U]),
    );
  }

  /**
   * L-attributed bind — parse `this`; for each value `v`, call `fn(v)` to
   * obtain the next parser and parse it. **Emits the pair `[v, w]`** — the
   * attribute-grammar shape (inherited + synthesized values), NOT a monadic
   * bind in result shape (a monadic bind would yield `Parser<U>`).
   *
   * Discard the first component when only the second value is needed:
   * `.chain(fn).map(([, w]) => w)` — or use {@link Parser.bind}, the
   * result-only companion.
   */
  chain<U>(fn: (t: T) => Parser<U>): Parser<[T, U]> {
    return new Parser<[T, U]>(
      new ChainExp<T, U>(this._exp, (v) => fn(v as T)._exp),
    );
  }

  /**
   * L-attributed bind, result-only — like {@link Parser.chain} but emits
   * only the second value: `Parser<U>` instead of `Parser<[T, U]>`. Use
   * when the first value is already in scope via closure capture and the
   * pair would be discarded. Equivalent to
   * `this.chain(fn).map(([, w]) => w)`.
   */
  bind<U>(fn: (t: T) => Parser<U>): Parser<U> {
    return this.chain(fn).map(([, w]) => w);
  }

  /** A* — Kleene star; parse trees are arrays `T[]`. */
  many(): Parser<T[]> {
    const inner = this._exp;
    const repExp: DelayedExp<T[]> = new DelayedExp<T[]>(() =>
      new AltExp([
        new EpsilonExp<T[]>([]),
        new SeqExp(
          "_rep",
          [inner, repExp],
          ([h, t]) => [h as T, ...(t as T[])],
        ),
      ])
    );
    return new Parser<T[]>(repExp);
  }

  /** A? — optional; parse trees are `T | undefined`. */
  opt(): Parser<T | undefined> {
    return this.or(new Parser<undefined>(new EpsilonExp<undefined>(undefined)));
  }
}

/** Build a `Parser` wrapping a pre-existing `Exp` (escape hatch for Grammar internals). */
export function parserOf<T>(exp: Exp): Parser<T> {
  return new Parser<T>(exp);
}

/** The empty parser `∅` — fails on all inputs. */
export function emptyParser<T = never>(): Parser<T> {
  return new Parser<T>(new EmptyExp());
}

/* ─── Positional / compositional parsing primitives ─────────────────── */

/**
 * Attribution kind of a segment boundary.
 *
 * - `"S"` — S-attributed: the segment depends on no inherited context, so it
 *   can be parsed independently of any prefix. Composition is trivial
 *   (concatenate forests).
 * - `"L"` — L-attributed: the segment depends on inherited context derived
 *   from the prefix. Composition requires the prefix's synthesized values to
 *   build the checkpoint for the next segment.
 */
export type AttributionKind = "S" | "L";

/**
 * A context checkpoint: a resumable parse position together with the start
 * parser that has the inherited context baked in.
 *
 * The derivative parser's self-containment property means the state after
 * consuming `k` tokens recognises the suffix `[k, n)` without needing the
 * consumed prefix `[0, k)`. A `Checkpoint` makes that resumption point a
 * value: `offset` is the absolute character position in the source, and
 * `start` is the parser to drive over the suffix (built by the grammar with
 * the inherited context at `offset` already captured in its closures).
 *
 * Build checkpoints via {@link Grammar.checkpointAt}; parse segments via
 * {@link Grammar.parseSegment}.
 */
export interface Checkpoint<T> {
  /** Absolute character offset in the source string where the segment begins. */
  readonly offset: number;
  /**
   * The parser to drive over the suffix `[offset, end)`. For an L-attributed
   * segment this parser has the inherited context at `offset` baked in.
   */
  readonly start: Parser<T>;
  /** Attribution kind of the boundary, for composition safety checks. */
  readonly kind: AttributionKind;
}
