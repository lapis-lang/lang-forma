/**
 * Standalone parser combinators — the functional vocabulary for building
 * grammars without `this.` boilerplate.
 *
 * Pure functions wrapping the same `Exp` nodes that {@link Grammar} uses
 * internally. These supersede the former `this.`-prefixed methods on
 * `Grammar`; existing code must migrate to importing the standalone
 * functions.
 *
 * See the README for the full introduction and design rationale.
 */

import {
  AltExp,
  ChainExp,
  DelayedExp,
  EmptyExp,
  EpsilonExp,
  type Exp,
  PredTokExp,
  SeqExp,
  TokExp,
} from "./zipper.ts";
import { Parser } from "./Parser.ts";
import type { Diagnostic } from "./Grammar.ts";

/* ─── Terminals ──────────────────────────────────────────────────────── */

/** A literal single character; semantic value is the matched character. */
export function char(c: string): Parser<string> {
  return new Parser<string>(new TokExp({ tag: c, sym: c, offset: -1 }));
}

/** A character matching a predicate; semantic value is the matched character. */
export function pred(
  p: (c: string) => boolean,
  label = "<pred>",
): Parser<string> {
  return new Parser<string>(new PredTokExp(p, label));
}

/** A literal multi-character string; semantic value is the string itself. */
export function literal(s: string): Parser<string> {
  if (s.length === 0) return epsilon("");
  const chars = [...s];
  const seq = new SeqExp(
    `_lit_${s}`,
    chars.map((c) => new TokExp({ tag: c, sym: c, offset: -1 })),
    () => s,
  );
  return new Parser<string>(seq);
}

/* ─── Empties ────────────────────────────────────────────────────────── */

/** ∅ — the failing parser.  Produces no parse trees on any input. */
export function empty<T = never>(): Parser<T> {
  return new Parser<T>(new EmptyExp());
}

/** ε — always succeeds, contributing `value` to the parse forest. */
export function epsilon<T>(value: T): Parser<T> {
  return new Parser<T>(new EpsilonExp<T>(value));
}

/** ε carrying a `Diagnostic` — for `@rescue` handlers. */
export function diagnostic(
  message: string,
  reason = "error",
): Parser<Diagnostic> {
  return epsilon<Diagnostic>({ reason, message });
}

/* ─── Structure ──────────────────────────────────────────────────────── */

/** Variadic alternation — succeeds if any branch succeeds. */
export function or<T>(...parsers: Parser<T>[]): Parser<T> {
  if (parsers.length === 0) return empty<T>();
  if (parsers.length === 1) return parsers[0]!;
  return new Parser<T>(new AltExp(parsers.map((p) => p._exp)));
}

/** Variadic sequence; the parse tree is a tuple of the children's results. `seq(a, b, c)` produces `[A, B, C]`. */
export function seq<Ts extends readonly unknown[]>(
  ...parsers: { [K in keyof Ts]: Parser<Ts[K]> }
): Parser<Ts> {
  if (parsers.length === 0) return epsilon([] as unknown as Ts);
  const exps = (parsers as Parser<unknown>[]).map((p) => p._exp);
  return new Parser<Ts>(new SeqExp("_seq", exps, (vs) => vs as unknown as Ts));
}

/**
 * L-attributed bind — parse `first`; for each value `v`, call `fn(v)` to
 * obtain the next parser and parse it. **Emits the pair `[v, w]`** — the
 * attribute-grammar shape (inherited + synthesized values), NOT a monadic
 * bind in result shape (a monadic bind would yield `Parser<U>`).
 *
 * Discard the first component when only the second value is needed:
 * `chain(first, fn).map(([, w]) => w)` — or use {@link bind}, the
 * result-only companion.
 */
export function chain<T, U>(
  first: Parser<T>,
  fn: (t: T) => Parser<U>,
): Parser<[T, U]> {
  return new Parser<[T, U]>(
    new ChainExp<T, U>(first._exp, (v) => fn(v as T)._exp),
  );
}

/**
 * L-attributed bind, result-only — like {@link chain} but emits only the
 * second value: `Parser<U>` instead of `Parser<[T, U]>`. Use when the
 * chain value is available via closure capture and the pair would be
 * discarded. Equivalent to `chain(first, fn).map(([, u]) => u)`.
 */
export function bind<T, U>(
  first: Parser<T>,
  fn: (t: T) => Parser<U>,
): Parser<U> {
  return chain(first, fn).map(([, u]) => u);
}

/* ─── Sigspace sequence ──────────────────────────────────────────────── */

/**
 * Sigspace (significant-whitespace) sequence — like {@link seq} but auto-inserts `ws` (non-capturing)
 * between every pair of terms.
 *
 * The inserted `ws` results are dropped from the output tuple, so the
 * callback receives only the meaningful terms.
 */
export function sseq<Ts extends readonly unknown[]>(
  ws: Parser<unknown>,
  ...parsers: { [K in keyof Ts]: Parser<Ts[K]> }
): Parser<Ts> {
  if (parsers.length === 0) return epsilon([] as unknown as Ts);
  if (parsers.length === 1) return parsers[0] as Parser<Ts>;
  const terms = parsers as Parser<unknown>[];
  // Interleave: term₀, ws, term₁, ws, term₂, …
  const interleaved: Exp[] = [];
  const termIndices: number[] = []; // which output positions are real terms
  for (let i = 0; i < terms.length; i++) {
    interleaved.push(terms[i]!._exp);
    termIndices.push(interleaved.length - 1);
    if (i < terms.length - 1) interleaved.push(ws._exp); // non-capturing
  }
  return new Parser<Ts>(
    new SeqExp("_sseq", interleaved, (vs) => {
      const out: unknown[] = [];
      for (const idx of termIndices) out.push(vs[idx]);
      return out as unknown as Ts;
    }),
  );
}

/* ─── Repetition & utility combinators ───────────────────────────────── */

/** One-or-more repetition (`A+`). Parse trees are arrays `T[]`. */
export function plus<T>(p: Parser<T>): Parser<T[]> {
  return seq(p, p.many()).map(([h, t]) => [h, ...t]);
}

/** Zero-or-more separated list. Separators are not included in the result. `sepBy(digit, char(","))` ⇒ `["1","2","3"]`. */
export function sepBy<T>(p: Parser<T>, sep: Parser<unknown>): Parser<T[]> {
  return or(
    seq(p, star(seq(sep, p).map(([, x]) => x))).map(([h, t]) => [h, ...t]),
    epsilon([] as T[]),
  );
}

/**
 * Alias of {@link sepBy} — zero-or-more separated list (`*` form).
 *
 * Provided so the `Star`/`Plus` naming convention is symmetric: pair
 * `sepByStar` with {@link sepByPlus}. `sepBy` remains the canonical name
 * (used downstream); `sepByStar` is a non-breaking alias for discoverability.
 */
export const sepByStar = sepBy;

/**
 * One-or-more separated list (`+` form). Separators are not included in the
 * result. `sepByPlus(digit, char(","))` ⇒ `["1","2","3"]` (fails on empty).
 *
 * Unlike {@link sepBy}, this is **not nullable** — it requires at least one
 * element. Use `sepByPlus(p, sep).opt()` for an unambiguous "optionally a
 * non-empty list" (empty → `undefined`, non-empty → `T[]`).
 *
 * **Footgun avoided:** `sepBy(p, sep).opt()` is redundant — `sepBy` already
 * matches empty (returning `[]`), so `.opt()` adds a *second* empty match
 * returning `undefined`. For empty input this yields two distinct values
 * (`[]` and `undefined`) — a genuine semantic ambiguity, not a cosmetic
 * duplicate. Prefer `sepByPlus(p, sep).opt()` when you need "optionally a
 * list", or plain `sepBy(p, sep)` when zero elements should yield `[]`.
 */
export function sepByPlus<T>(p: Parser<T>, sep: Parser<unknown>): Parser<T[]> {
  return seq(p, star(seq(sep, p).map(([, x]) => x))).map(([h, t]) => [h, ...t]);
}

/**
 * Standalone `A*` — zero-or-more repetition, implemented via a cyclic
 * `DelayedExp`. Equivalent to `p.many()` (the method form) and exported so
 * the `Star`/`Plus` naming convention is available as standalone functions:
 * pair `star` with {@link plus}.
 *
 * `p.many()` remains the canonical method form; `star` is a non-breaking
 * alias for grammars that prefer the regex-style vocabulary.
 */
export function star<T>(p: Parser<T>): Parser<T[]> {
  const inner = p._exp;
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

/** Wrap `p` between `open` and `close`, returning only `p`'s result. */
export function between<T>(
  open: Parser<unknown>,
  p: Parser<T>,
  close: Parser<unknown>,
): Parser<T> {
  return seq(open, p, close).map(([, x]) => x);
}

/** Trim `p` with `ws` on both sides, returning `p`'s result. */
export function trim<T>(p: Parser<T>, ws: Parser<unknown>): Parser<T> {
  return seq(ws, p, ws).map(([, x]) => x);
}

/**
 * Keyword literal with a reserved-word guard.
 *
 * Matches the literal `word`, but rejects it if `word` is in `reserved`.
 * If `reserved` is omitted, no guard is applied.
 */
export function keyword(
  word: string,
  reserved: readonly string[] = [],
): Parser<string> {
  if (reserved.length === 0) return literal(word);
  return literal(word).chain((matched) => {
    if (reserved.includes(matched)) return empty<string>();
    return epsilon(matched);
  }).map(([, r]) => r);
}
