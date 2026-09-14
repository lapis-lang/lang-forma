# @lapis-lang/lang-forma

An executable grammar engine for TypeScript that unifies syntax, static semantics, dynamic semantics, and proof generation into single-pass derivations.

Built on **Parsing with Zippers** (Darragh & Adams, ICFP 2020), monadic context threading, and grammar-native Design by Contract, **LangForma** expands on Gilad Bracha's concept of *executable grammars*. Rather than constructing passive ASTs for separate multi-pass visitor traversals, grammars are defined as object-oriented **classes** whose productions are methods—turning executable grammars into unified language engines and formal proof systems.

> 📖 **Companion Article**: For a detailed breakdown of the theory, architecture, and design philosophy behind this library, see [Beyond the Parser: Executable Grammars and Semantics](https://thenewobjective.com/types-and-programming-languages/beyond-the-parser-executable-grammars/).

Grammars are written as **classes**; productions are methods. Recursion — including left-recursion, context-sensitive parameters, and ambiguity — is handled natively by lazy references and the PwZ zipper engine.

```ts
import { Grammar, rule, char, epsilon, or, seq } from '@lapis-lang/lang-forma';

class BalancedParens extends Grammar<{ s: string }> {
    start() { return this.s; }
    @rule get s() {
        return or(
            seq(char('('), this.s, char(')'), this.s).map(() => 'ok'),
            epsilon('ok'),
        );
    }
}

new BalancedParens().recognize('(()())'); // true
new BalancedParens().parse('()');         // Set { 'ok' }
```

## Installation

```bash
# Deno
deno add jsr:@lapis-lang/lang-forma

# npm / yarn / pnpm / bun
npx jsr add @lapis-lang/lang-forma
```

Then import from `jsr:@lapis-lang/lang-forma` (Deno) or `@lapis-lang/lang-forma` (Node-style resolvers via the JSR npm compatibility layer).

## Why "executable grammars"?

A grammar class **is** the parser. Productions are real methods, so they can
be **overridden** in subclasses to extend or wrap behaviour:

```ts
class Traced extends MathEval {
    readonly trace: number[] = [];
    @rule override get expr() {
        return super.expr.map((n) => { this.trace.push(n); return n; });
    }
}
```

Composition by inheritance, not by re-defining the grammar from scratch. See
[examples/arith.ts](examples/arith.ts).

## Shape-typed grammars

For grammars with multiple productions returning different parse-tree types,
parameterise the grammar by a **shape interface** mapping production names to
their parse-tree types:

```ts
interface MathShape { [k: string]: unknown; expr: unknown; term: unknown; factor: unknown }

abstract class AbstractMath<S extends MathShape> extends Grammar<S> {
    protected abstract add(l: S['expr'], r: S['term']): S['expr'];
    protected abstract num(s: string): S['factor'];
    @rule get expr(): Parser<S['expr']> { /* ... */ }
    @rule get term(): Parser<S['term']> { /* ... */ }
    @rule get factor(): Parser<S['factor']> { /* ... */ }
}

class MathEval extends AbstractMath<{ expr: number; term: number; factor: number }> {
    protected add(l: number, r: number) { return l + r; }
    /* ... */
}

class MathAST  extends AbstractMath<{ expr: Exp; term: Exp; factor: Exp }> {
    protected add(l: Exp, r: Exp): Exp { return { tag: 'add', left: l, right: r }; }
    /* ... */
}
```

The shape generalises the single-type `Grammar<T>` pattern (one global result
type) to per-production result types while keeping subclass overrides
type-safe.

## Context-sensitive (parameterised) grammars

When a production depends on runtime context — such as the current
indentation depth — declare it as a `@rule` **method** instead of a getter.
The decorator caches a separate `DelayedExp` slot per `(instance, method,
arguments)` tuple, so calling `this.block(2)` and `this.block(4)` creates
two independent, mutually-recursive parser nodes.

```ts
class IndentLang extends Grammar<{ doc: Node[] }> {
    override start() { return this.block(0); }

    @rule block(depth: number): Parser<Node[]> {
        return seq(this.line(depth), this.block(depth).opt())
            .map(([first, rest]) => [first, ...(rest ?? [])]);
    }

    @rule line(depth: number): Parser<Node> {
        // leaf:   <spaces> key ": " value "\n"
        const leaf = seq(this.spaces(depth), this.key, literal(': '), this.value, char('\n'))
            .map(([, k, , v]) => ({ kind: 'leaf' as const, key: k, value: v }));
        // branch: <spaces> key ":\n" <nested block>
        const branch = seq(this.spaces(depth), this.key, literal(':\n'), this.block(depth + 2))
            .map(([, k, , children]) => ({ kind: 'branch' as const, key: k, children }));
        return or(branch, leaf);
    }

    @rule spaces(n: number): Parser<string> {
        if (n === 0) return epsilon('');
        return seq(char(' '), this.spaces(n - 1)).map(() => '');
    }
}
```

See [examples/indent.ts](examples/indent.ts) for the full working example,
including `key` and `value` productions.

## Semantics as grammars

Inference rules and grammar productions are two sides of the same coin.
A typing judgment `Γ ⊢ e : τ` can be encoded as a parameterised production
`expr(Γ): Parser<Type>`; an evaluation judgment `ρ ⊢ e ⇓ v` as
`expr(ρ): Parser<Value>`.  The grammar is no longer merely recognising
syntax — it is *deriving judgments*.

This is [**syntax-directed translation**](https://en.wikipedia.org/wiki/Syntax-directed_translation):
each production carries a semantic rule that computes a value from its
children's values.  Attribute grammars are the formal foundation; this
library encodes them as grammar-class methods.

### From textbook attribute grammars to executable grammars

A textbook attribute grammar attaches **semantic rules** to productions in
square brackets.  For example, arithmetic evaluation:

```
Expr1 → Expr2 + Term   [ Expr1.value = Expr2.value + Term.value ]
Expr  → Term           [ Expr.value  = Term.value ]
Term1 → Term2 * Factor [ Term1.value = Term2.value * Factor.value ]
Term  → Factor         [ Term.value  = Factor.value ]
Factor → "(" Expr ")"  [ Factor.value = Expr.value ]
Factor → integer       [ Factor.value = strToInt(integer.str) ]
```

Each `.value` is a **synthesized attribute** — computed bottom-up from
children.  In this library, the same grammar is an executable grammar class
where each production is a `@rule` method and the semantic rule is a `.map()`
callback:

```ts
class MathEval extends Grammar<MathShape> {
    @rule get expr(): Parser<number> {
        return or(
            seq(this.term, char('+'), this.expr).map(([t, , e]) => t + e),  // Expr1 → Expr2 + Term
            this.term,                                                       // Expr → Term
        );
    }
    @rule get term(): Parser<number> {
        return or(
            seq(this.factor, char('*'), this.term).map(([f, , t]) => f * t), // Term1 → Term2 * Factor
            this.factor,                                                     // Term → Factor
        );
    }
    @rule get factor(): Parser<number> {
        return or(
            seq(char('('), this.expr, char(')')).map(([, e]) => e),         // Factor → "(" Expr ")"
            this.intLiteral.map((s) => Number(s)),                           // Factor → integer
        );
    }
}
```

The correspondence is direct:

| Textbook attribute grammar       | This library                              |
| -------------------------------- | ----------------------------------------- |
| Production `A → B C`             | `@rule` method returning `Parser<T>`      |
| Synthesized attribute `A.value` | `.map(([b, c]) => ...)` — the method's return value |
| Inherited attribute (top-down)   | `@rule expr(Γ)` method argument           |
| Semantic rule in `[ brackets ]`  | `.map()` callback                          |
| L-attributed (one-pass)          | `chain(first, fn)` — pair-emitting bind     |
| L-attributed (one-pass, result-only) | `bind(first, fn)` — discards the pair's first component |
| Two-phase evaluation             | `super.expr.map(evalFn)` (multi-pass)       |

See [examples/arith.ts](examples/arith.ts) for the full arithmetic evaluator.

### Inherited vs. synthesized attributes

The textbook example above uses only **synthesized** attributes — each
node's value is computed from its children's values, flowing bottom-up.
Many languages also need **inherited** attributes — values that flow
top-down from a parent to its children, such as a type environment `Γ` or a
value environment `ρ`.  This library encodes inherited attributes as
**method arguments** on parameterised `@rule` methods:

```ts
// Inherited: Γ (the type environment) flows top-down via the method argument.
@rule exprProd(ctx: TypeEnv): Parser<Type> { ... }
```

and **synthesized** attributes as `.map()` return values flowing bottom-up.

### The `chain` combinator (pair-emitting bind)

The key enabler for L-attributed grammars (inherited attributes that depend
on a left sibling's synthesized attribute) is `chain`.  It parses the first
parser, then — *after* it completes — calls a function with the result to
construct the second parser.  This lets a left sibling's *synthesized*
value determine the right sibling's *inherited* context:

```ts
@rule
protected lambdaProd(ctx: unknown): Parser<S['expr']> {
    return seq(
        this.lambdaHead, this.ident, this.ws, char(':'), this.ws,
        this.type, this.ws, char('.'), this.ws,
    ).chain(([, param, , , , ty, , , ]) =>
        // τ is now available; extend ctx and parse body.
        this.exprProd(this.extendCtx(ctx, param, ty))
            .map((body) => this.lam(param, ty, body))
    ).map(([, result]) => result);
}
```

`chain` **emits the pair `[v, w]`** — both children's values flow upward
together.  This is the attribute-grammar shape, not a monadic bind's result
shape (a monadic bind would yield only `w`), and it is what keeps the left
siblings' values available to later `.chain`/`.map` callbacks.  When only
the second value is needed, discard the first:
`.map(([, result]) => result)`, as the example above does — or reach for
the **result-only companion**, `bind`:

```ts
// bind(first, fn) ≡ chain(first, fn).map(([, result]) => result)
bind(seq(/* ... */), ([, param, , , , ty, , , ]) =>
    this.exprProd(this.extendCtx(ctx, param, ty))
        .map((body) => this.lam(param, ty, body))
)
```

`bind` has the monadic result shape (`Parser<U>`) because in L-attributed
grammars the inherited value is already in scope via closure capture when
the callback runs — the pair's first component would be discarded anyway.

Without `chain`, `seq` builds all children eagerly at construction time, so
the parsed `τ` cannot flow into `body`'s parser.  `chain` defers construction
of the second parser until the first has completed — exactly when the zipper
reaches that point in the left-to-right traversal.

### Examples

| Example | Pattern | Demonstrates |
| ------- | ------- | ------------- |
| `arith-var.ts` | Pattern 2 (read-only env) | Inherited attributes, variable lookup |
| `stlc.ts` | Both | One-pass type checking (Pattern 2), one-pass evaluation (higher-order attributes), proof-bearing type checking |
| `proplogic.ts` | Both | Truth evaluation (Pattern 2), natural-deduction proofs (Pattern 1) |
| `lambda-eval.ts` | Higher-order attributes | Untyped evaluation as a one-pass grammar subclass |

See [examples/stlc.ts](examples/stlc.ts) for the headline example: Simply
Typed Lambda Calculus with four interpretations (AST, type checker,
evaluator, proof-bearing type checker) over one abstract grammar.

## Higher-order attributes (one-pass evaluation)

The semantics patterns above cover static semantics (types, proofs) but stop
short of *dynamic* semantics — runtime value evaluation — when the language
has higher-order features (closures). Applying a closure `λx. body` to an
argument `v` produces a **new tree fragment** (the body with `x` bound to
`v`) that must itself be evaluated; the evaluation tree grows at runtime.

A **higher-order attribute** is a semantic action that re-enters the engine
over a fragment of the input under a different inherited context. For
evaluation, `app` captures the closure body's **input span** and re-parses
that substring under the extended environment via `parseSegment`. This lets the
evaluator be a single grammar class extending the abstract grammar — the
same shape as a type checker — with no intermediate AST and no separate
recursive function.

```ts
class STLCEval extends AbstractSTLC<{ expr: Value; atom: Value; type: Type }> {
    parseWith(input: string, env: ValEnv): Set<Value> {
        this._input = input;
        return this._parseWith(input, this.exprProd(env));
    }

    // The higher-order step: app re-parses the closure body's source
    // substring under an extended env via parseSegment.
    protected app(fn: Value, arg: Value): Value {
        if (!(fn instanceof Closure)) throw new Error('cannot apply');
        const bodyEnv = fn.env.extend(fn.param, arg);
        return [...this.parseSegment(this._input, fn.bodySpan.start, this.exprProd(bodyEnv), fn.bodySpan.end)][0]!;
    }
}
```

`parseSegment` spins up a fresh `ZipperDriver` over the substring; per-pass memo isolation (stale-position detection in `goDown`) makes the nested re-entry safe — the same grammar instance may be reused without leaking state.

See [examples/stlc.ts](examples/stlc.ts) and
[examples/lambda-eval.ts](examples/lambda-eval.ts) for the full evaluators.

## Positional & compositional parsing primitives

A key property of derivative parsing is that the state after consuming `k`
tokens — the **derivative** — is self-contained: it recognises the suffix
`[k, n)` without needing the consumed prefix `[0, k)`. This makes the engine
well-suited for incremental, parallel, and positional parsing — the features
that matter for IDEs, syntax highlighting, and error recovery.

### Segment parsing & context checkpoints

`parseSegment` parses an arbitrary segment `[startOffset, endOffset)` of the
input under a given start parser, returning the parse forest. Spans in
semantic actions are reported in **absolute** coordinates (relative to the
original input), so callers need no offset compensation.

A **checkpoint** captures the inherited context at a boundary as a value:

```ts
import type { Checkpoint } from '@lapis-lang/lang-forma';

interface Checkpoint<T> {
    readonly offset: number;      // absolute char offset where the segment begins
    readonly start: Parser<T>;    // parser with inherited context baked in
    readonly kind: "S" | "L";     // S-attributed (independent) or L-attributed
}
```

Grammars with inherited context override `checkpointAt` to reconstruct the
context at a boundary and bake it into the returned checkpoint's `start`
parser. `parseSegmentFrom` is the convenience form taking a `Checkpoint`.

### Segment composition

`composeSegmentsS` composes independently-parsed S-attributed segments (no
inherited context crosses boundaries) — the union of their forests.
`composeSegmentsL` composes L-attributed segments by threading synthesized
values from each segment into the next segment's checkpoint via a
grammar-supplied `nextCheckpoint` callback:

```ts
const composed = g.composeSegmentsL(input, initialCheckpoint, [boundary1, boundary2],
    (prevResults, prevEnd, i) => g.checkpointAt(prevEnd, recoverCtx(prevResults, i)));
```

The composed result equals what a one-shot parse of the whole input would
produce.

### Incremental re-parsing

After a small edit, `reparseIncremental` re-parses only the affected region,
reusing memoised derivations for the unchanged prefix and suffix. See
[examples/incremental-demo.ts](examples/incremental-demo.ts) for a working
demonstration.

For non-blocking or streaming use, `ZipperDriver` can be driven token-by-token
via `init` / `step` / `flushEof` / `forest` — see the API table below.

### Fixpoint composition (circular attribute flow)

`parseToFixpoint` iterates a fixpoint over handler body types for circular
attribute flow: it repeatedly parses handler bodies under a context σ, joins
the results, and re-parses until σₙ₊₁ = σₙ (convergence). An optional
`maxIterations` cap is available as a safety net.

See [examples/circular-attr-demo.ts](examples/circular-attr-demo.ts) for a
demonstration.

## Grammar-native contracts

A typing rule like

```
Γ ⊢ fn : τ₁ → τ₂    Γ ⊢ arg : τ₁
────────────────────────────────  (App)
        Γ ⊢ fn arg : τ₂
```

has two parts: the **premises** above the line (`fn` is a function type;
its domain matches `arg`'s type) and the **conclusion** below (the result
is the codomain). Traditionally you'd hand-code this as an `if` guard
inside the semantic action, returning a sentinel on failure:

```ts
// Traditional: the inference rule buried in an if-statement
protected app(fn: Type, arg: Type): Type {
    if (!(fn instanceof TFun) || !typeEq(fn.dom, arg)) {
        return undefined as unknown as Type;  // premise failed — reject
    }
    return (fn as TFun).cod;                   // conclusion
}
```

This library ships a small **Design by Contract** system — `@requires`,
`@ensures`, `@invariant`, plus `assert`, `implies`, `iff` — that lets you
declare the premises and conclusion *as* the rule, rather than burying them
in imperative guards. The key adaptation for the parsing domain: **`@requires`
fails gracefully** (the branch produces an empty parse forest) rather than
throwing, because a failed premise means the inference rule doesn't apply —
the term is ill-typed, not a crashed program.

```ts
// With contracts: the rule is declared, not buried.
// `args`/`result` types are inferred from the method signature — no
// manual annotation needed inside the predicates.
@requires((_self, fn, arg) =>
    fn instanceof TFun && typeEq(fn.dom, arg))   // premises
@ensures((_self, _args, _old, result) =>
    result instanceof TVar || result instanceof TFun)  // conclusion
protected app(fn: Type, _arg: Type): Type {
    return (fn as TFun).cod;                     // the rule's body
}

new STLCTypeCheck().parseWith('\\x:Int. x x', TypeEnv.empty());  // Set {} — ill-typed, no throw
```

### `assert` / `implies` / `iff` — inline logical primitives

Zero integration cost. `assert` throws on failure (it catches *bugs*, not
parse failures) and narrows types in TypeScript — useful for the
`unknown`-typed `ctx` in parameterised productions:

```ts
import { assert, implies, iff } from '@lapis-lang/lang-forma';

@rule
protected lambdaProd(ctx: unknown): Parser<S['expr']> {
    return seq(/* ... */).chain(([, param, , , , ty, , ,]) => {
        assert(typeof param === 'string', 'param must be a string');
        assert(ty instanceof TVar || ty instanceof TFun, 'ty must be a Type');
        return this.exprProd(this.extendCtx(ctx, param, ty))
            .map((body) => this.lam(param, ty, body));
    });
}

// Material implication and biconditional for composing predicates:
implies(fn instanceof TFun, typeEq(fn.dom, arg));   // !p || q
iff(result instanceof TVar, /* condition */);       // (p && q) || (!p && !q)
```

### `@requires` — inference-rule premises

Declares the premises above the line. On failure, the method returns
`undefined` — the calling `chain`/`.map` callback then produces `empty()`,
so the branch is rejected without raising an exception. This replaces the
manual `if`-guard-and-return-sentinel pattern with a declarative premise:

```ts
import { requires } from '@lapis-lang/lang-forma';

// The Var rule's premise: x must be bound in Γ.
@requires((_self, name, ctx) =>
    ctx instanceof TypeEnv && ctx.lookup(name) !== undefined)
protected varRef(name: string, ctx: unknown): Type {
    return (ctx as TypeEnv).lookup(name) as Type;
}
```

### `@ensures` — inference-rule conclusions

Declares the conclusion below the line — a postcondition on the method's
result. The predicate receives `(self, args, old, result)` where `args` is
the whole `Parameters` tuple of the method, `result` is its `ReturnType`,
and `old` is an `OldSnapshot` of `self` (its own enumerable string-keyed
*data* properties as they were before the body ran — getters and methods
are absent). All three are **inferred from the method signature**, so no
manual annotation is needed inside the predicate. A violated postcondition
is a *bug* (e.g. a missing `return`), so it throws `ContractError`:

```ts
import { ensures } from '@lapis-lang/lang-forma';

// The App rule's conclusion: the result is a valid Type.
// `result: Type` is inferred from `app(...): Type`.
@ensures((_self, _args, _old, result) =>
    result instanceof TVar || result instanceof TFun)
protected app(fn: Type, arg: Type): Type {
    return (fn as TFun).cod;
}
```

### `@invariant` — grammar well-formedness

A class decorator declaring an invariant that must hold after construction
and after every contracted semantic-action call. Catches grammar
construction bugs (e.g. a production that accidentally returns `undefined`):

```ts
import { invariant } from '@lapis-lang/lang-forma';

@invariant((self: AbstractSTLC<any>) => self.start() !== undefined)
abstract class AbstractSTLC<S extends STLCShape> extends Grammar<S> { /* ... */ }
```

### `@rescue` — parse-failure recovery

Declares a handler invoked when a production's parse yields an empty forest.
The handler receives a `ParseFailure` (with `reason`, `message`, `position`,
`production`) and may report a diagnostic, return an alternative parser, or
call `retry` to re-run the production once. The `args` parameter is typed as
`Parameters` of the decorated production — inferred, no manual annotation
needed (for getter productions `args` is `[]`). Inherited unless overridden
(most-derived wins):

```ts
import { rescue } from '@lapis-lang/lang-forma';

// `args` is inferred as `[unknown]` from `appProd(ctx: unknown)`.
@rescue((self, failure, _args, retry) => {
    self.diagnostic(`type error: ${failure.message}`, failure.reason);
    return self.empty();
})
@rule
protected override appProd(ctx: unknown): Parser<Type> { /* ... */ }
```

### `diagnostic()` — reporting failure reasons

A `Grammar` helper that produces an epsilon parser carrying a `Diagnostic`
value (`{ reason, message }`) through the parse forest, so callers can
report *why* a branch failed without raising an exception:

```ts
return diagnostic('ill-typed application: Int is not a function', 'type-mismatch');
```

### Subcontracting (Liskov)

Contracts compose across inheritance exactly as Liskov substitution
requires — automatically, because the Proxy walks the prototype chain:

| Decorator   | Composition | Meaning                              |
| ----------- | ----------- | ------------------------------------ |
| `@invariant`| AND-ed      | Subclass invariant strengthens       |
| `@requires` | OR-ed       | Subclass accepts a *superset* of inputs (weakens) |
| `@ensures`  | AND-ed      | Subclass guarantees a *more specific* result (strengthens) |

A subclass that overrides `app` without re-declaring `@ensures` is still
checked against the parent's postcondition. The subclass
refines the production's meaning, and the contract system enforces that the
refinement is a valid strengthening.

### Checked mode

Contract checking is enabled by default. The global default applies live
to every `Grammar` instance — toggling it affects existing instances
immediately. (The internal `withoutChecks` recursion guard is scoped
per-instance so concurrent operations on different instances don't
interfere.) Disable for zero production overhead:

```ts
import { setCheckedMode } from '@lapis-lang/lang-forma';

setCheckedMode(false);  // all instances skip checks — zero overhead
```

### Reflective contract metadata

Each contract decorator accepts an optional second argument — an arbitrary
metadata object whose shape the library does **not** define. The metadata is
stored alongside the executable predicate (as a `{ predicate, meta? }` pair)
and exposed reflectively, so you can build documentation generators, test
generators, or verifiers on top without the library committing to any
specific use case.

```ts
import { requires, ensures } from '@lapis-lang/lang-forma';

// The second argument is an arbitrary object — these keys (rule,
// formula) are this author's choice; a JSON/CSV grammar could use entirely
// different keys. The library stores and round-trips it opaquely.
@requires(
    (_self, fn, arg) => fn instanceof TFun && typeEq(fn.dom, arg),
    { rule: 'T-App', formula: 'fn : σ → τ  ∧  arg <: σ' },
)
@ensures(
    (_self, _args, _old, result) => result instanceof TVar || result instanceof TFun,
    { rule: 'T-App', formula: 'result : τ' },
)
protected app(fn: Type, _arg: Type): Type { return (fn as TFun).cod; }
```

`@rule` accepts the same optional metadata, in factory form:

```ts
import { rule } from '@lapis-lang/lang-forma';

@rule({ rule: 'T-App', production: 'appProd' })
protected override appProd(ctx: unknown): Parser<Type> { /* ... */ }
```

The `Grammar.metadata` static getter aggregates every contract across the
inheritance chain (most-derived first), exposing **both** the executable
predicate and the declarative metadata for each contract:

```ts
import { STLCTypeCheck } from './stlc.ts';

const report = STLCTypeCheck.metadata;
// report.methods.app.requires[0].meta  → { rule: 'T-App', formula: '...' }
// report.methods.app.requires[0].predicate  → the executable (self, fn, arg) => boolean

// Invoke a predicate reflectively (pass the instance as `self`):
const tc = new STLCTypeCheck();
const ok = report.methods.app.requires[0].predicate(
    tc, new TFun(new TVar('Int'), new TVar('Int')), new TVar('Int'),
);  // → true
```

The report shape (shown with `Function` for brevity; the exported
`RequiresContract` / `EnsuresContract` / `InvariantContract` types use the
precise `RequiresPredicate` / `EnsuresPredicate` / `InvariantPredicate`
predicate signatures):

```ts
interface ContractMetadataReport {
    methods: Record<PropertyKey, {
        requires: { predicate: Function; meta?: ContractMeta }[];
        ensures:  { predicate: Function; meta?: ContractMeta }[];
        rule?:    { meta?: ContractMeta };
        isRule:   boolean;
    }>;
    invariants: { predicate: Function; meta?: ContractMeta }[];
}
```

`ContractMeta` is `Record<string, unknown>` - a schema-less object. The
lower-level `metadataOf(Class)`, `chainMetadata(instance)`, and
`collectMetadata(instanceOrClass)` accessors are also exported for tooling
that needs per-class or per-instance access. Metadata is class-level
(static), so it is accessible even when `setCheckedMode(false)`.

## Source positions

Every `.map()` callback receives a `Span` as its second argument describing
the half-open character-offset range `[start, end)` of the matched input:

```ts
import type { Span } from '@lapis-lang/lang-forma';

interface Node { text: string; span: Span }

const word = grammar.word.map(
    (text, span): Node => ({ text, span })
    //              ^^^^ { start: number; end: number }
);
```

`start` is the 0-based offset of the first character consumed by the
production; `end` is the offset *after* the last character (so `end - start`
is the length of the matched region). Callbacks that only need the value can
still use a single-parameter arrow function — the extra argument is simply
ignored.

## API

```ts
import {
    Grammar, Parser, ZipperDriver,
    assert, implies, iff,
    requires, ensures, invariant,
    setCheckedMode, getCheckedMode,
    ContractError, AssertionError,
    MonotonicityViolationError, FixpointDivergenceError,
} from '@lapis-lang/lang-forma';
import type { Span, Checkpoint, AttributionKind, Pos, Tok } from '@lapis-lang/lang-forma';
```

### Combinators — standalone functions

Import from `@lapis-lang/lang-forma` and use without `this.`:

| Function              | Effect                                     |
| --------------------- | ------------------------------------------ |
| `char(c)`             | Match one literal character.               |
| `pred(p, label?)`     | Match a character predicate.               |
| `literal(s)`          | Match a multi-character literal.           |
| `epsilon(value)`      | ε — always succeeds, yielding `value`.     |
| `diagnostic(msg, reason?)` | ε carrying a `Diagnostic` — for `@rescue` handlers. |
| `empty()`             | ∅ — the failing parser.                    |
| `or(...parsers)`      | Variadic alternation.                      |
| `seq(...parsers)`     | Variadic concatenation; returns tuple.     |
| `chain(first, fn)`    | L-attributed bind — emits the pair `[T, U]` (not a monadic bind's `Parser<U>`). Discard the first with `.map(([, w]) => w)`. |
| `bind(first, fn)`     | L-attributed bind, result-only — yields `Parser<U>`. Like `chain` but skips the pair; use when the first value is available via closure capture. |
| `sseq(ws, ...parsers)`| Sigspace sequence — auto-inserts `ws` (non-capturing) between terms. |
| `plus(p)`             | One-or-more repetition (`A+`).             |
| `star(p)`             | Zero-or-more repetition (`A*`); alias of `p.many()`. |
| `sepBy(p, sep)`        | Zero-or-more separated list.               |
| `sepByStar(p, sep)`    | Alias of `sepBy` (the `*` form).           |
| `sepByPlus(p, sep)`    | One-or-more separated list (non-nullable; use `.opt()` for "optionally a list"). |
| `between(open, p, close)` | Wrap `p` between delimiters, returning `p`'s result. |
| `trim(p, ws)`         | Wrap `p` with `ws` on both sides.          |
| `keyword(word, reserved?)` | Literal with reserved-word guard.     |
| `parserOf(exp)`       | Wrap a raw `Exp` as a `Parser<T>`. |

### `Grammar<S>` — abstract base

Subclass and define productions as `@rule` getters (or methods) returning
`Parser<T>`. The base class provides:

| Member | Effect |
| ----------------------------------- | ------------------------------------------ |
| `ws` (overridable getter) | Whitespace production used by `sseq`. Default: zero or more spaces/tabs/newlines/CR. |
| `sseq(...parsers)` | Sigspace sequence — like `seq` but auto-inserts `this.ws` between terms. |
| `parse(input)` / `recognize(input)` | Drivers — full forest / boolean. |
| `parseSegment(input, startOffset, start, endOffset?)` | Parse a segment under `start`; spans are absolute. |
| `parseSegmentFrom(input, checkpoint, endOffset?)` | Parse a segment from a `Checkpoint` (context baked in). |
| `checkpointAt(input, offset)` | Build a `Checkpoint` at a boundary (override in grammars with inherited context). |
| `composeSegmentsS(forests)` | Compose S-attributed segments (union of independent forests). |
| `composeSegmentsL(input, cp, ends, nextCp)` | Compose L-attributed segments, threading context across boundaries. |
| `reparseIncremental(input, start, editStart, editEnd, priorDriver)` | Re-parse after an edit, reusing memos for the unchanged region. |
| `parseToFixpoint(sigma, parseBodies, join, eq?, maxIterations?)` | Iterate a fixpoint for circular attribute flow. |

The `@rule` decorator can wrap either a **getter** or a **method**:

- `@rule get foo()` — memoised per instance; the canonical form for
  non-parameterised productions.
- `@rule foo(arg)` — memoised per `(instance, arg)`; use this for
  context-sensitive productions such as `block(depth)`.
  Each distinct argument set gets its own `DelayedExp` slot, so recursive
  calls with the same argument thread through the same shared node.

### `Parser<T>` — fluent algebra

| Method      | Effect                                          |
| ----------- | ----------------------------------------------- |
| `or(other)` | A ∪ B                                           |
| `then(other)`| A ○ B — parse trees are pairs `[T, U]`.        |
| `map(f)`    | Semantic action. `f` receives `(value: T, span: Span)` where `Span = { start: number; end: number }` is the half-open character-offset range `[start, end)` of the matched input. |
| `chain(fn)` | L-attributed bind. `fn` receives the parsed value `T` and returns a `Parser<U>`; result is the pair `Parser<[T, U]>` (not a monadic bind's `Parser<U>`). Enables L-attributed one-pass parsing. |
| `bind(fn)`  | L-attributed bind, result-only. Like `chain(fn)` but yields `Parser<U>` — the pair's first component is skipped. |
| `many()`    | A\* — parse trees are arrays `T[]`.             |
| `opt()`     | A ∪ ε — parse trees are `T \| undefined`.       |

### Lexemes — shared character-level building blocks

| Function | Effect |
| -------- | ------ |
| `ws()` | Zero-or-more whitespace (space, tab, newline, CR). |
| `ws1()` | One-or-more whitespace. |
| `wsChar()` | A single whitespace character. |
| `digit()` | A single decimal digit `[0-9]`. |
| `digits()` | One or more digits, joined into a string. |
| `ident(first?, rest?)` | Identifier — lowercase letter followed by letters/digits/`_`. Predicates optional. |

### Contracts

| Export | Kind | Effect |
| --------------- | --------- | --------------------------------------------------------------- |
| `assert(c, m?)` | function | Inline assertion; throws `AssertionError` on failure; narrows `c`'s type. |
| `implies(p, q)` | function | Material implication `!p \|\| q`. |
| `iff(p, q)` | function | Biconditional `(p && q) \|\| (!p && !q)`. |
| `@requires` | decorator | Precondition `(self, ...args) => boolean`; on failure returns `undefined` (graceful → `empty()`). `args` types are inferred from the decorated method. OR-ed across inheritance. |
| `@ensures` | decorator | Postcondition `(self, args, old, result) => boolean`; throws `ContractError` on failure. `args`/`result` inferred from the method; `old` is an `OldSnapshot<This>` (data-only). AND-ed across inheritance. |
| `@invariant` | decorator | Class invariant; checked after construction and after each contracted call. AND-ed across inheritance. |
| `@rescue` | decorator | Parse-failure recovery; handler `(self, failure, args, retry?) => unknown` invoked when a production yields an empty forest. `args` inferred from the decorated production (`Parameters`; `[]` for getters). Inherited (most-derived wins). |
| `setCheckedMode(b)` / `getCheckedMode()` | function | Toggle the global default for contract enforcement. Applies live to all instances (existing and new). When off, no Proxy is created for new instances and existing Proxies skip checks (zero overhead). |
| `Grammar.metadata` | static getter | Aggregated contract metadata report across the inheritance chain — exposes both predicates and declarative meta. |
| `collectMetadata(instanceOrClass)` | function | Build a `ContractMetadataReport` from an instance or a class. |
| `metadataOf(Class)` / `chainMetadata(instance)` | function | Lower-level per-class / per-instance metadata accessors. |
| `ContractMeta` | type | `Record<string, unknown>` — arbitrary, schema-less metadata object attached via the optional second arg of `@requires`/`@ensures`/`@invariant`/`@rule`. |
| `ContractError` / `AssertionError` | class | Error types thrown by `@ensures`/`@invariant` and `assert` respectively. |
| `ParseFailure` / `Diagnostic` | type | `{ reason, message?, ... }` — failure description passed to `@rescue` / carried by `diagnostic()`. |

## How it works

The parsing engine is **Parsing with Zippers** (Darragh & Adams, ICFP 2020).

### Why not derivatives?

Brzozowski derivatives are an elegant parsing technique: for each input
character, you compute a *new grammar* that represents "what's left to
parse." The derivative of `'a' 'b'` with respect to `'a'` is `'b'`; the
derivative of `'b'` with respect to `'b'` is ε (success).

The problem is **cost**: each derivative step rewrites the *entire grammar
tree*, producing a new tree. For ambiguous grammars, the trees grow
exponentially — every alternative spawns a copy, and copies of copies
compound. Sharing can help, but detecting equality on cyclic grammar graphs
is expensive, and semantic actions (which carry arbitrary values) make
equality checks impractical.

PwZ takes a different approach: **don't rewrite the grammar — walk it.**

### The zipper approach

Instead of computing global Brzozowski derivatives, the engine maintains a
*worklist of zippers* — each zipper is a **cursor** that walks through the
grammar tree, one step per character — and **shares notes** when cursors
meet at the same node.

### The analogy

The grammar is a **maze** (a tree of rooms); the input is a **sequence of
keys**. Each zipper is a person walking through the maze with a notepad. At
each step (one key), every person advances one room. People who hit a locked
door (token mismatch) disappear. People who reach the exit are the parse
results. If two people arrive at the same room at the same time, they
**share notes** (memoization) instead of re-exploring.

### A tiny example

Grammar: `S ::= 'a' 'b'` (match the string `"ab"`)

![Grammar tree for S ::= 'a' 'b'](docs/diagrams/tiny-grammar.svg)

**Step 1 — input `'a'`:** the zipper descends into `Seq` → first child
`Tok('a')`. The token matches → **completes** with value `"a"`, goes **up**
to `Seq`, which advances to the next child `Tok('b')`.

![Step 1 — input 'a': zipper at Tok('b'), accumulated ['a']](docs/diagrams/step1-zipper.svg)

**Step 2 — input `'b'`:** the zipper is at `Tok('b')`. The token matches →
**completes** with value `"b"`, goes **up** to `Seq` — no more children →
`Seq` **completes** with `["a", "b"]`.

**Result:** `["a", "b"]` ✓

### Ambiguity: multiple zippers

Grammar: `S ::= S '+' S | '1'` (match `"1+1+1"` — two valid parse trees).
Multiple zippers explore different branches *simultaneously*:

![Ambiguity step 1 — two branches explore simultaneously](docs/diagrams/ambiguity-step1.svg)

![Ambiguity step 2 — three branches after input '+'](docs/diagrams/ambiguity-step2.svg)

Each zipper carries its own accumulated value. At the end, all zippers that
reach the exit produce a **parse forest** — one tree per valid parse. The
forest is a `Set`, so it deduplicates by value: identical **primitive**
results collapse (`or(char('a'), char('a'))` over `"a"` yields one result),
while identical **object** results are kept as distinct entries (two
`['a','b']` arrays from genuinely ambiguous branches stay two).

### The key trick: sharing notes (memoization)

When two zippers reach the **same grammar node** at the **same input
position**, they don't re-explore — they share:

![Without memoization: exponential re-exploration](docs/diagrams/no-memo.svg)

![With PwZ memoization: polynomial — shared exploration](docs/diagrams/with-memo.svg)

This is what makes PwZ **polynomial time** on ambiguous grammars — the
sharing prevents exponential blowup. The `Mem` object is the "shared
notepad": when a zipper arrives at a node it's already visited at this
position, it just threads its parent context into the existing memo and
reuses the already-computed values.

### Left recursion: the other trick

Traditional top-down parsers choke on left recursion (`S ::= S '+' S | '1'`)
because `S` calls `S` infinitely. PwZ handles it because of memoization:

![Left recursion in PwZ — memo seeds and grows](docs/diagrams/left-recursion.svg)

The first visit creates an (empty) memo. The recursive call hits the same
memo — it doesn't loop infinitely, it just waits. When the base case (`'1'`)
completes, the memo fills in, and the recursive call picks up the result.
This is the "seed growing" pattern: the memo starts empty and grows as the
parse progresses.

### Summary

![PwZ summary: the step loop](docs/diagrams/summary-loop.svg)

PwZ in a nutshell: **cursors walking a tree, sharing notes, handling
ambiguity and left recursion through memoization**. The rest (semantic
actions, `chain`, `@rule`, shape-typed grammars) is built on top of this
core mechanism.

## Retained derivation trees (multi-pass parsing)

The single-pass, inline-semantics design is elegant and efficient for
L-attributed grammars — the vast majority of real-world cases. But certain
patterns benefit from parsing once structurally, then running multiple
semantic passes over the result:

- **Multi-pass evaluation**: type checking and evaluation can share a single
  structural parse instead of re-parsing the input independently for each pass.
- **Circular attribute flow**: `let rec` bindings can be resolved by re-walking
  the retained tree under different contexts, without re-parsing.

`Grammar.parseToTree(input)` is the opt-in tree-*producing* entry point.
It captures *which `@rule` production matched where, with child relationships
and source spans* as a first-class `DerivationTree`:

```ts
const { forest, trees } = grammar.parseToTree(input);
// forest: the inline parse result (same as grammar.parse(input))
// trees:  retained derivation trees (one per derivation in an ambiguous parse)

const tree = trees[0]!;
tree.root.label;   // "expr" — the @rule production name
tree.root.span;    // { start: 0, end: 11 } — absolute source span
tree.root.children; // sub-derivations
```

The derivation tree is walked by subclassing `SemanticPass` and overriding a
method named after each production label. The method receives the node and the
already-computed results of its children (in source order):

```ts
import { SemanticPass, Grammar, rule, or, seq, char, epsilon } from '@lapis-lang/lang-forma';

class DepthPass extends SemanticPass<{ s: number }> {
  s(node: DerivationNode, children: number[]): number {
    return children.length === 0 ? 0 : 1 + Math.max(...children);
  }
}
const depth = new DepthPass().evaluate(tree);
```

`SemanticPass` is the OOP-native way to run a semantic pass — subclass and
override, mirroring the grammar's shape. It enables Code Contracts
(`@ensures` / `@requires` / `@invariant` / `@rescue` on semantic methods),
shape-typing (`SemanticPass<{ s: number }>`), inheritance composition
(the Decorator pattern — override one method, inherit the rest), and stateful
passes (inherited attributes via `this`).

If a production label has no corresponding method, a default handler is used:
for a node with exactly one child, the child's result is returned (passthrough
for chains like `expr → term → factor`); otherwise an error is thrown. Override
`defaultHandler` to customise this behaviour.

The inline single-pass `parse()` path is **unaffected** — `parseToTree` is
purely additive and does not change the behaviour or performance of
`parse()` or `recognize()`.

See [examples/multipass-demo.ts](examples/multipass-demo.ts) for a working
multi-pass example: parse once, then run multiple semantic passes over the
shared derivation tree.

## Program generation & unparsing (the dual of parsing)

Where `parse()` consumes tokens bottom-up to build values, `generate()` walks
the grammar's `Exp` tree **top-down**, emitting tokens and computing semantic
values. This is L-system style expansion: starting from an initial production
(axiom), the generator expands non-terminals until terminals are reached.

```ts
const g = new MathEval();
const { value, tokens, tree } = g.generate({
  seed: 42,
  maxDepth: 4,
});
const src = tokens.map(t => t.sym).join('');  // e.g. "3*2"
// Round-trip: parse the generated source
[...g.parse(src)];  // → [6]
```

### Generator options

| Option | Default | Description |
|---|---|---|
| `maxDepth` | `6` | Maximum derivation depth (number of `DelayedExp`/`AltExp` descents). |
| `maxRecursion` | `2` | Max times a single recursive `DelayedExp` may be re-entered on the current path. |
| `seed` | `0` | Random seed for reproducible generation. Same seed → same output. |
| `alphabet` | alphanumeric + ws | Character alphabet for sampling predicate-based terminals. |
| `maxBacktracks` | `50` | Max backtracks before giving up on a branch. |
| `maxSteps` | `10000` | Total walk-step cap (safety net against infinite loops). |
| `branchStrategy` | `"depth-first"` | Branch ordering: `"depth-first"` (recursive branches first — maximal L-system expansion), `"breadth-first"` (terminals first — minimal derivation), or `"random"` (shuffled — diverse PBT samples). |

### Generating from a named production

`generateFrom(ruleName, args?, options?)` resolves a `@rule` production
reflectively — including parameterised (method) productions:

```ts
const { value } = g.generateFrom('term', [], { seed: 0, maxDepth: 3 });
```

### Unparsing (inverse parsing)

`Grammar.unparse(tree)` converts a `DerivationTree` back to source text. The
default `UnparsePass` reconstructs from spans (zero-config); for
pretty-printing, subclass `SemanticPass<Record<string, string>>` and override
methods named after production labels:

```ts
const { trees } = g.parseToTree('1+2*3');
g.unparse(trees[0]);  // → "1+2*3"
```

### Native property-based testing

`Grammar.toGenerator(options)` builds a `ValueGenerator` with
**grammar-aware shrinking**. Shrinking
re-generates at shallower depths, producing structurally smaller
counterexamples that stay well-formed:

```ts
const gen = g.toGenerator({ maxDepth: 5 });
gen.forAll((n) => typeof n === 'number' && Number.isFinite(n), { numRuns: 100 });
// Throws PropertyFailure with a minimized counterexample if the property fails.
```

## First-class inference rules

Grammars that annotate `@requires`/`@ensures` with `meta.rule` (the
inference-rule convention) get first-class `InferenceRule` objects via
`Grammar.rules`:

```ts
const rules = STLCTypeCheck.rules;
const tApp = rules.find(r => r.name === 'T-App');
tApp.premises;    // [{ formula: "fn : σ → τ  ∧  arg <: σ", ... }]
tApp.conclusion;  // [{ formula: "result : τ", ... }]
tApp.production;  // "appProd"
```

Each rule has a `format()` method that renders it in standard proof-tree
notation. The layout maps directly to the decorator metadata:

```text
premise₁   premise₂   …        if ϕ
─────────────────────────────  ruleName  (production)
conclusion                     provided ψ
```

| Position | Decorator | `role` (default) | `role` (override) |
|---|---|---|---|
| Above the bar | `@requires` | `"premise"` (omitted) | `"side"` → `if ϕ` |
| Rule-name line | `@rule({ rule, production })` | — | — |
| Below the bar | `@ensures` | `"conclusion"` (omitted) | `"frame"` → `provided ψ` |

Premises (`@requires`) appear above the bar; the conclusion (`@ensures`)
appears below. The `@rule` metadata supplies the rule name and links the
production. Side conditions (`@requires` with `role: "side"`) render as
`if ϕ` right-aligned above the bar; frame conditions (`@ensures` with
`role: "frame"`) render as `provided ψ` right-aligned below the bar.
Conjoined premises (`∧`) are split into the traditional horizontal spacing:

```ts
console.log(tApp.format());
// fn : σ → τ    arg <: σ
// ──────────────────────────  T-App  (appProd)
// result : τ
```

This is an opt-in interpretive layer over the schema-less `ContractMeta` —
grammars that don't follow the convention return an empty array. First-class
rules enable type-directed generation and static metatheory analysis.

## Metatheory Verification

LangForma can verify metatheoretic properties of a grammar's semantics —
**Progress** and **Preservation** (Subject Reduction) — by analyzing the
grammar class itself, without requiring manual proof-assistant code (Coq/Lean).

The engine combines static rule-structure analysis, unification-based type
checking (via a built-in yield-kanren engine), and generative counterexample
search. See the companion article for the theoretical background.

### Annotating dynamic semantics

To verify Progress and Preservation, the dynamic-semantics rules (evaluation
judgments `ρ ⊢ e ⇓ v`) must be annotated with `@requires`/`@ensures` metadata
following the `rule`/`formula` convention, just like the static semantics.
The optional `role` key distinguishes **side conditions** (`@requires` with
`role: "side"`) and **frame conditions** (`@ensures` with `role: "frame"`).
When `role` is omitted, `@requires` defaults to `"premise"` and `@ensures`
defaults to `"conclusion"`:

```ts
@requires(
  (_self, fn, _arg) => fn instanceof Closure,
  { rule: "E-App", formula: "ρ ⊢ e₁ ⇓ ⟨x,τ,span,ρ'⟩" },
)
@ensures(
  (_self, _args, _old, result) => isValueOrPlaceholder(result),
  { rule: "E-App", formula: "ρ ⊢ e₁ e₂ ⇓ v" },
)
protected override app(fn: Value, arg: Value): Value { ... }
```

### Verifying a grammar

```ts
import { STLCEval, STLCTypeCheck } from './examples/stlc.ts';

// Static analysis + unification (Progress + Preservation):
const report = STLCEval.metatheory;
console.log(report.progress.holds);    // true
console.log(report.preservation.holds); // true
console.log(report.preservation.unification?.length); // 2

// Generative counterexample search:
import { findCounterexamples } from '@lapis-lang/lang-forma';
const ev = new STLCEval();
const tc = new STLCTypeCheck();
const search = findCounterexamples(ev, tc, { numRuns: 100, seed: 42 });
console.log(search.passed); // true
```

See [examples/stlc-metatheory-demo.ts](examples/stlc-metatheory-demo.ts) for a full demonstration.

## References

- Pierce Darragh & Michael D. Adams,
  [*"Parsing with Zippers"*](https://michaeldadams.org/papers/parsing-with-zippers/parsing-with-zippers.pdf), ICFP 2020.
- Gilad Bracha,
  [*"Executable Grammars in Newspeak"*](https://bracha.org/executableGrammars.pdf), ENTCS 2007.
- Matthew Might, David Darais & Daniel Spiewak,
  [*"Parsing with Derivatives — A Functional Pearl"*](https://matt.might.net/papers/might2011derivatives.pdf), ICFP 2011.
- [Syntax-directed translation](https://en.wikipedia.org/wiki/Syntax-directed_translation) — the formal foundation for attaching semantic rules to productions.
- [Attribute grammar](https://en.wikipedia.org/wiki/Attribute_grammar) — synthesized and inherited attributes.
- [decorator-contracts](https://github.com/final-hill/decorator-contracts) — the inspiration for the grammar-native contracts system.
- [Design by Contract](https://en.wikipedia.org/wiki/Design_by_contract),
  [Liskov Substitution Principle](https://en.wikipedia.org/wiki/Liskov_substitution_principle).
- [microKanren (Hemann & Friedman, 2013)](https://github.com/jasonhemann/microKanren) —
  the minimal relational programming core that inspired the yield-kanren engine.
- [Yield Prolog](https://yieldprolog.sourceforge.net/) —
  generator-based backtracking with `yield`/`for...of`, the synthesis insight
  behind yield-kanren.

## License

MPL-2.0.
