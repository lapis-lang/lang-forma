/**
 * Simply Typed Lambda Calculus — four interpretations of one grammar:
 * AST builder, type checker, evaluator, proof-bearing type checker.
 * Uses `chain` for L-attributed one-pass context threading. See the README.
 */

import { Grammar, rule } from "../src/index.ts";
import {
  char,
  digits as digitsLexeme,
  empty,
  epsilon,
  ident as identLexeme,
  literal,
  or,
  seq,
  ws as wsLexeme,
  ws1 as ws1Lexeme,
} from "../src/index.ts";
import type { Parser, Span } from "../src/index.ts";
import { assert, ensures, invariant, requires } from "../src/index.ts";

/* ======================================================================
 *  Types
 * ====================================================================== */

export class TVar {
  constructor(readonly name: string) {}
  toString(): string {
    return this.name;
  }
}

export class TFun {
  constructor(readonly dom: Type, readonly cod: Type) {}
  toString(): string {
    return `(${this.dom} → ${this.cod})`;
  }
}

export type Type = TVar | TFun;

export function typeEq(a: Type, b: Type): boolean {
  if (a instanceof TVar && b instanceof TVar) return a.name === b.name;
  if (a instanceof TFun && b instanceof TFun) {
    return typeEq(a.dom, b.dom) && typeEq(a.cod, b.cod);
  }
  return false;
}

/* ======================================================================
 *  Terms (AST) — for STLCAST
 * ====================================================================== */

export abstract class Term {
  abstract print(): string;
}

export class Var extends Term {
  constructor(readonly name: string) {
    super();
  }
  override print(): string {
    return this.name;
  }
}

export class Lam extends Term {
  constructor(
    readonly param: string,
    readonly type: Type,
    readonly body: Term,
  ) {
    super();
  }
  override print(): string {
    return `(λ${this.param}:${this.type}. ${this.body.print()})`;
  }
}

export class App extends Term {
  constructor(readonly fn: Term, readonly arg: Term) {
    super();
  }
  override print(): string {
    return `(${this.fn.print()} ${this.arg.print()})`;
  }
}

export class Let extends Term {
  constructor(
    readonly name: string,
    readonly type: Type,
    readonly def: Term,
    readonly body: Term,
  ) {
    super();
  }
  override print(): string {
    return `(let ${this.name}:${this.type} = ${this.def.print()} in ${this.body.print()})`;
  }
}

export class BoolLit extends Term {
  constructor(readonly value: boolean) {
    super();
  }
  override print(): string {
    return String(this.value);
  }
}

export class IntLit extends Term {
  constructor(readonly value: number) {
    super();
  }
  override print(): string {
    return String(this.value);
  }
}

/* ======================================================================
 *  Typed terms (proof-bearing — a typing derivation tree)
 * ====================================================================== */

export abstract class TypedTerm {
  abstract readonly type: Type;
  abstract print(): string;
}

export class TypedVar extends TypedTerm {
  constructor(readonly name: string, readonly type: Type) {
    super();
  }
  override print(): string {
    return `${this.name}:${this.type}`;
  }
}

export class TypedLam extends TypedTerm {
  readonly type: TFun;
  constructor(
    readonly param: string,
    readonly paramType: Type,
    readonly body: TypedTerm,
  ) {
    super();
    this.type = new TFun(paramType, body.type);
  }
  override print(): string {
    return `(λ${this.param}:${this.paramType}. ${this.body.print()}) : ${this.type}`;
  }
}

export class TypedApp extends TypedTerm {
  constructor(
    readonly fn: TypedTerm,
    readonly arg: TypedTerm,
    readonly type: Type,
  ) {
    super();
  }
  override print(): string {
    return `(${this.fn.print()} @ ${this.arg.print()}) : ${this.type}`;
  }
}

export class TypedLet extends TypedTerm {
  constructor(
    readonly name: string,
    readonly type: Type,
    readonly def: TypedTerm,
    readonly body: TypedTerm,
  ) {
    super();
  }
  override print(): string {
    return `(let ${this.name}:${this.type} = ${this.def.print()} in ${this.body.print()}) : ${this.body.type}`;
  }
}

export class TypedBool extends TypedTerm {
  readonly type: Type;
  constructor(readonly value: boolean) {
    super();
    this.type = new TVar("Bool");
  }
  override print(): string {
    return `${this.value}:${this.type}`;
  }
}

export class TypedInt extends TypedTerm {
  readonly type: Type;
  constructor(readonly value: number) {
    super();
    this.type = new TVar("Int");
  }
  override print(): string {
    return `${this.value}:${this.type}`;
  }
}

/* ======================================================================
 *  Values (evaluation results)
 * ====================================================================== */

export type Value = Closure | boolean | number;

/**
 * Value classification for the dynamic semantics. A term is a *value* (a
 * normal form that needs no further evaluation) iff it is a closure, a
 * boolean, or a number. Used by the metatheory engine to partition
 * terms into values vs. non-values for the **Progress** check
 * ($\\text{Well-Typed} \\implies \\text{Value} \\lor \\text{Can Step}$).
 */
export function isValue(v: Value): boolean {
  return v instanceof Closure || typeof v === "boolean" ||
    typeof v === "number";
}

/**
 * Like {@link isValue} but also accepts the `PLACEHOLDER` sentinel used
 * during lambda body span capture. The metatheory `@ensures` predicates use
 * this so runtime contract checking doesn't reject the placeholder bound
 * during the span-capture pass (the placeholder is never a real result —
 * only the span is kept).
 */
export function isValueOrPlaceholder(v: Value): boolean {
  return isValue(v) || typeof v === "symbol";
}

/**
 * Sentinel placeholder value used when parsing a lambda body for span
 * capture. The body is parsed under an env where the parameter is bound to
 * this sentinel, so `varRef` succeeds (the value is never used — only the
 * span is kept). Must be non-null because `ValEnv.lookup` maps `null` to
 * `undefined` (unbound) via `??`. A unique symbol avoids confusion with any
 * real `Value`.
 */
const PLACEHOLDER = Symbol("PLACEHOLDER") as unknown as Value;

/**
 * A closure capturing the body's **input span** (not a pre-evaluated body
 * value). The body is re-evaluated on demand by re-parsing its source
 * substring under the extended environment — the higher-order attribute
 * mechanism for one-pass evaluation.
 */
export class Closure {
  constructor(
    readonly param: string,
    readonly type: Type,
    readonly bodySpan: Span,
    readonly env: ValEnv,
  ) {}
}

/* ======================================================================
 *  Type environment  (Γ — the typing context)
 * ====================================================================== */

export class TypeEnv {
  private constructor(
    readonly name: string | null,
    readonly type: Type | null,
    readonly parent: TypeEnv | null,
  ) {}

  static empty(): TypeEnv {
    return new TypeEnv(null, null, null);
  }

  extend(name: string, type: Type): TypeEnv {
    return new TypeEnv(name, type, this);
  }

  lookup(name: string): Type | undefined {
    if (this.name === name) return this.type ?? undefined;
    return this.parent?.lookup(name);
  }
}

/* ======================================================================
 *  Value environment  (ρ — the evaluation context)
 * ====================================================================== */

export class ValEnv {
  private constructor(
    readonly name: string | null,
    readonly value: Value | null,
    readonly parent: ValEnv | null,
  ) {}

  static empty(): ValEnv {
    return new ValEnv(null, null, null);
  }

  extend(name: string, value: Value): ValEnv {
    return new ValEnv(name, value, this);
  }

  lookup(name: string): Value | undefined {
    if (this.name === name) return this.value ?? undefined;
    return this.parent?.lookup(name);
  }
}

/* ======================================================================
 *  Shape
 * ====================================================================== */

export interface STLCShape {
  [k: string]: unknown;
  expr: unknown;
  atom: unknown;
  type: unknown;
}

/* ======================================================================
 *  Abstract grammar — shared structure
 * ====================================================================== */

/**
 * Base STLC grammar — productions, lexemes, and context threading.
 *
 * `ctx` is inherited context (TypeEnv, ValEnv, or null).  `chain` threads
 * synthesized values into inherited context.
 *
 * The semantic-action methods (`lam`, `app`, `let_`, `varRef`, `boolLit`,
 * `intLit`, `paren`) have **throwing default implementations**. They are
 * reachable only via the base `lambdaProd`/`letProd`/`appProd`/`atomProd`
 * productions. Subclasses that **override productions** (like `STLCEval`)
 * extend this class directly and never call the actions. Subclasses that
 * **override actions** (like `STLCAST`, `STLCTypeCheck`) extend
 * {@link AbstractSTLCActions}, which re-declares the actions as abstract for
 * compile-time safety.
 */
@invariant((self: AbstractSTLC<STLCShape>) => self.start() !== undefined)
export abstract class AbstractSTLC<S extends STLCShape> extends Grammar<S> {
  /* ── semantic actions (throwing defaults — overridden by action subclasses) ── */

  protected lam(_param: string, _type: Type, _body: S["expr"]): S["expr"] {
    throw new Error(
      "lam() unreachable — override the action or the production",
    );
  }
  protected app(_fn: S["atom"], _arg: S["atom"]): S["expr"] {
    throw new Error(
      "app() unreachable — override the action or the production",
    );
  }
  protected let_(
    _name: string,
    _type: Type,
    _def: S["expr"],
    _body: S["expr"],
  ): S["expr"] {
    throw new Error(
      "let_() unreachable — override the action or the production",
    );
  }
  protected varRef(_name: string, _ctx: unknown): S["atom"] {
    throw new Error(
      "varRef() unreachable — override the action or the production",
    );
  }
  protected boolLit(_b: boolean): S["atom"] {
    throw new Error(
      "boolLit() unreachable — override the action or the production",
    );
  }
  protected intLit(_n: number): S["atom"] {
    throw new Error(
      "intLit() unreachable — override the action or the production",
    );
  }
  protected paren(_e: S["expr"]): S["atom"] {
    throw new Error(
      "paren() unreachable — override the action or the production",
    );
  }

  /* ── type production (shared — always returns Type) ──────────────── */

  @rule
  get type(): Parser<Type> {
    return or(
      this.sseq(this.atomType, this.arrow, this.type)
        .map(([dom, , cod]) => new TFun(dom, cod)),
      this.atomType,
    );
  }

  protected get arrow(): Parser<string> {
    return or(literal("→"), literal("->"));
  }

  @rule
  protected get atomType(): Parser<Type> {
    // `sseq` auto-inserts `ws` between terms in the parenthesised case.
    return or(
      this.typeIdent.map((name) => new TVar(name)),
      this.sseq(char("("), this.type, char(")"))
        .map(([, t]) => t),
    );
  }

  @rule
  protected get typeIdent(): Parser<string> {
    // Uppercase type identifiers — uses ident() with a custom first-char predicate.
    return identLexeme(
      (c) => c >= "A" && c <= "Z",
      (c) =>
        (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") ||
        (c >= "0" && c <= "9"),
    );
  }

  /* ── term productions (parameterised by context) ─────────────────── */
  //
  // `ctx` is the inherited context: `TypeEnv` (Γ) for type checking,
  // `ValEnv` (ρ) for evaluation, or `null` for pure syntax.  The `chain`
  // combinator lets a parsed annotation/value extend `ctx` before parsing
  // the body — the L-attributed pattern.

  @rule
  exprProd(ctx: unknown): Parser<S["expr"]> {
    return or(
      this.lambdaProd(ctx),
      this.letProd(ctx),
      this.appProd(ctx),
    );
  }

  /** `λx:τ. body` — chain on τ to extend ctx before parsing body. */
  @rule
  protected lambdaProd(ctx: unknown): Parser<S["expr"]> {
    // `sseq` auto-inserts `ws` between each term.  A trailing `ws` is kept
    // explicit (via the wrapping `seq`) so the body parser sees leading
    // whitespace consumed before it starts — `sseq` only inserts ws
    // *between* terms, not after the last.
    return seq(
      this.sseq(
        this.lambdaHead, // 0  (within sseq tuple)
        this.ident, // 1  param
        char(":"), // 2
        this.type, // 3  τ
        char("."), // 4
      ),
      this.ws, // 1  (within seq tuple) — trailing ws before body
    ).chain(([[, param, , ty]]) => {
      // τ is now available; extend ctx and parse body.
      assert(typeof param === "string", "lambda param must be a string");
      assert(
        ty instanceof TVar || ty instanceof TFun,
        "lambda type must be a Type",
      );
      return this.exprProd(this.extendCtx(ctx, param, ty))
        .map((body) => this.lam(param, ty, body));
    }).map(([, result]) => result);
  }

  /** `let x:τ = def in body` — chain on τ then def's result to extend ctx for body. */
  @rule
  protected letProd(ctx: unknown): Parser<S["expr"]> {
    return seq(
      literal("let"), // 0
      this.ws1, // 1
      this.ident, // 2  name
      this.ws, // 3
      char(":"), // 4
      this.ws, // 5
      this.type, // 6  τ
      this.ws, // 7
      char("="), // 8
      this.ws, // 9
    ).chain(([, , name, , , , ty]) =>
      // Parse def under outer ctx, then consume "in", then parse body.
      this.exprProd(ctx)
        .map((def) => ({ name, ty, def }))
        .chain(({ name, ty, def }) =>
          seq(this.ws1, literal("in"), this.ws1)
            .chain(() =>
              this.exprProd(this.extendCtx(ctx, name, ty))
                .map((body) => this.let_(name, ty, def, body))
            )
            .map(([, result]) => result)
        )
        .map(([, result]) => result)
    ).map(([, result]) => result);
  }

  @rule
  protected appProd(ctx: unknown): Parser<S["expr"]> {
    return or(
      seq(this.appProd(ctx), this.ws1, this.atomProd(ctx))
        .map(([fn, , arg]) => this.app(fn, arg)),
      this.atomProd(ctx) as Parser<S["expr"]>,
    );
  }

  @rule
  protected atomProd(ctx: unknown): Parser<S["atom"]> {
    // `sseq` auto-inserts `ws` between terms in the parenthesised case.
    return or(
      this.sseq(char("("), this.exprProd(ctx), char(")"))
        .map(([, e]) => this.paren(e)),
      literal("true").map(() => this.boolLit(true)),
      literal("false").map(() => this.boolLit(false)),
      this.intLiteral.map((n) => this.intLit(n)),
      this.ident.map((name) => this.varRef(name, ctx)),
    );
  }

  /* ── context extension hook ──────────────────────────────────────── */
  //
  // `extendCtx` is called inside `chain` callbacks — *after* the annotation
  // is parsed, *before* the body is parsed.  The default is a no-op (for
  // `STLCAST`, which ignores context).  Semantic subclasses override it.

  protected extendCtx(ctx: unknown, _name: string, _type: Type): unknown {
    return ctx;
  }

  /* ── lexemes ─────────────────────────────────────────────────────── */
  //
  // `ident`, `digits`, `ws`, and `ws1` now come from the shared lexeme
  // library (`src/lexemes.ts`).  The reserved-word guard for `let`/`in`/
  // `true`/`false` is handled inline via `chain`.

  @rule
  protected get intLiteral(): Parser<number> {
    return digitsLexeme().map((s) => Number(s));
  }

  @rule
  protected get ident(): Parser<string> {
    return identLexeme().chain((name) => {
      if (
        name === "let" || name === "in" || name === "true" || name === "false"
      ) {
        return empty<string>();
      }
      return epsilon(name);
    }).map(([name]) => name);
  }

  protected get lambdaHead(): Parser<string> {
    return or(char("λ"), char("\\"));
  }

  @rule
  protected override get ws(): Parser<string> {
    return wsLexeme();
  }

  @rule
  protected get ws1(): Parser<string> {
    return ws1Lexeme();
  }
}

/**
 * Action layer — re-declares the semantic actions as abstract for
 * compile-time safety. Subclasses that **override actions** (not
 * productions) extend this class: `STLCAST`, `STLCTypeCheck`, `STLCTyped`.
 * They must implement every action, and the base productions call them.
 *
 * Subclasses that **override productions** (like `STLCEval`) extend
 * {@link AbstractSTLC} directly, bypassing the actions entirely.
 */
export abstract class AbstractSTLCActions<S extends STLCShape>
  extends AbstractSTLC<S> {
  protected abstract override lam(
    param: string,
    type: Type,
    body: S["expr"],
  ): S["expr"];
  protected abstract override app(fn: S["atom"], arg: S["atom"]): S["expr"];
  protected abstract override let_(
    name: string,
    type: Type,
    def: S["expr"],
    body: S["expr"],
  ): S["expr"];
  protected abstract override varRef(name: string, ctx: unknown): S["atom"];
  protected abstract override boolLit(b: boolean): S["atom"];
  protected abstract override intLit(n: number): S["atom"];
  protected abstract override paren(e: S["expr"]): S["atom"];
}

/* ======================================================================
 *  Concrete: AST builder (no context)
 * ====================================================================== */

export class STLCAST
  extends AbstractSTLCActions<{ expr: Term; atom: Term; type: Type }> {
  override start(): Parser<Term> {
    return this.exprProd(null);
  }

  protected lam(param: string, type: Type, body: Term): Term {
    return new Lam(param, type, body);
  }
  protected app(fn: Term, arg: Term): Term {
    return new App(fn, arg);
  }
  protected let_(name: string, type: Type, def: Term, body: Term): Term {
    return new Let(name, type, def, body);
  }
  protected varRef(name: string, _ctx: unknown): Term {
    return new Var(name);
  }
  protected boolLit(b: boolean): Term {
    return new BoolLit(b);
  }
  protected intLit(n: number): Term {
    return new IntLit(n);
  }
  protected paren(e: Term): Term {
    return e;
  }
}

/* ======================================================================
 *  Concrete: type checker  — `expr(Γ): Parser<Type>`
 * ====================================================================== */

/**
 * One-pass type checker.  `Γ ⊢ e : τ` is a parameterised production.
 * Ill-typed terms are rejected where a production checks the premise
 * inline (see the `appProd` override); a bare `@requires` failure
 * (e.g. an unbound variable) surfaces `undefined` in the forest.
 */
export class STLCTypeCheck
  extends AbstractSTLCActions<{ expr: Type; atom: Type; type: Type }> {
  parseWith(input: string, env: TypeEnv): Set<Type> {
    return this._parseWith(input, this.exprProd(env));
  }

  override start(): Parser<Type> {
    return this.exprProd(TypeEnv.empty());
  }

  protected override extendCtx(
    ctx: unknown,
    name: string,
    type: Type,
  ): unknown {
    return (ctx as TypeEnv).extend(name, type);
  }

  /** Abstraction typing rule (Abs).  The body's type is checked under the
   * extended context; the result is the function type `σ → τ`. */
  @ensures(
    (_self, _args, _old, result) => result instanceof TFun,
    {
      rule: "T-Abs",
      formula: "result : σ → τ",
      description:
        "the abstraction has a function type from the parameter's type to the body's type",
    },
  )
  protected lam(_param: string, type: Type, body: Type): Type {
    return new TFun(type, body);
  }
  /**
   * Application typing rule (App).  `@requires` enforces domain match;
   * on failure returns `undefined` (graceful). `args`/`result` types are
   * inferred from the method signature — no manual annotation needed.
   *
   * The second argument to `@requires` / `@ensures` is arbitrary declarative
   * metadata — the library imposes no schema; these keys (`rule`,
   * `formula`) are this example's choice. Both the predicate and the meta
   * are exposed reflectively via `STLCTypeCheck.metadata`.
   */
  @requires(
    (_self, fn, arg) => fn instanceof TFun && typeEq(fn.dom, arg),
    {
      rule: "T-App",
      formula: "fn : σ → τ  ∧  arg <: σ",
      description:
        "function must have a function type and argument must be a subtype of its domain",
    },
  )
  @ensures(
    (_self, _args, _old, result) =>
      result instanceof TVar || result instanceof TFun,
    {
      rule: "T-App",
      formula: "result : τ",
      description: "the application has the function's return type",
    },
  )
  protected app(fn: Type, _arg: Type): Type {
    // The premise is enforced by @requires; the body is the rule's conclusion.
    return (fn as TFun).cod;
  }
  protected let_(_name: string, _type: Type, _def: Type, body: Type): Type {
    return body;
  }
  /** Variable typing rule (Var).  `@requires` checks binding in ctx. */
  @requires(
    (_self, name, ctx) =>
      ctx instanceof TypeEnv && ctx.lookup(name) !== undefined,
    {
      rule: "T-Var",
      formula: "Γ(x) = τ",
      description: "the variable must be bound in the typing context",
    },
  )
  protected varRef(name: string, ctx: unknown): Type {
    return (ctx as TypeEnv).lookup(name) as Type;
  }
  protected boolLit(_b: boolean): Type {
    return new TVar("Bool");
  }
  protected intLit(_n: number): Type {
    return new TVar("Int");
  }
  protected paren(e: Type): Type {
    return e;
  }

  /**
   * Override `appProd` to type-check App via `chain`. This is the
   * runtime rejection layer: the premise (domain match) is checked
   * inline and a mismatch returns `empty()` — a bare `@requires` failure
   * (which surfaces `undefined`) does not reject the branch by itself.
   */
  @rule({ rule: "T-App", production: "appProd" })
  protected override appProd(ctx: unknown): Parser<Type> {
    return or(
      this.appProd(ctx)
        .map((fnTy) => ({ fnTy }))
        .chain(({ fnTy }) =>
          seq(this.ws1, this.atomProd(ctx))
            .map(([, argTy]) => ({ fnTy, argTy }))
            .chain(({ fnTy, argTy }) => {
              if (!(fnTy instanceof TFun) || !typeEq(fnTy.dom, argTy)) {
                return empty<Type>();
              }
              return epsilon<Type>(fnTy.cod);
            })
            .map(([, result]) => result)
        )
        .map(([, result]) => result),
      this.atomProd(ctx) as Parser<Type>,
    );
  }
}

/* ======================================================================
 *  Concrete: evaluator  — `expr(ρ): Parser<Value>`  (one-pass grammar)
 * ====================================================================== */

/**
 * One-pass evaluator — the same shape as `STLCTypeCheck`. Extends
 * `AbstractSTLC` directly; no intermediate AST, no separate recursive
 * function. The evaluation judgment `ρ ⊢ e ⇓ v` is a parameterised
 * production, with `ρ` (`ValEnv`) threaded as inherited context via `chain`.
 *
 * The higher-order step — applying a closure to an argument — is realised
 * by capturing the body's **input span** in the closure and re-parsing that
 * substring under the extended environment via `_forward`. This is a
 * higher-order attribute: a semantic action that re-enters the engine over a
 * fragment of the original input. Per-pass memo isolation makes the
 * nested re-entry safe.
 */
export class STLCEval
  extends AbstractSTLC<{ expr: Value; atom: Value; type: Type }> {
  /** The source text, stored so semantic actions can re-parse substrings. */
  private _input: string = "";
  /**
   * Base offset of the current parse relative to `_input`. The outer parse
   * starts at 0; a nested `_forward` re-parse of a substring starting at
   * offset `S` sets this to `S`, so spans captured inside the re-parse are
   * absolute (relative to the original `_input`), not relative to the
   * substring. This lets closures captured during a re-parse be applied
   * later against the original input.
   */
  private _inputOffset: number = 0;

  parseWith(input: string, env: ValEnv): Set<Value> {
    this._input = input;
    this._inputOffset = 0;
    return this._parseWith(input, this.exprProd(env));
  }

  override start(): Parser<Value> {
    return this.exprProd(ValEnv.empty());
  }

  protected override extendCtx(
    ctx: unknown,
    name: string,
    _type: Type,
  ): unknown {
    // For evaluation, ctx is ValEnv. Bind the name to a placeholder so the
    // body parses (the placeholder value is never used — only the span is
    // captured). The real binding happens when the closure is applied.
    // Use a unique sentinel object — `ValEnv.lookup` returns `undefined`
    // for `null` values (`value ?? undefined`), so `null` would be treated
    // as unbound. A non-null sentinel avoids that.
    return (ctx as ValEnv).extend(name, PLACEHOLDER);
  }

  /**
   * App: `ρ ⊢ e₁ e₂ ⇓ v` where `ρ ⊢ e₁ ⇓ ⟨x,τ,span,ρ'⟩`, `ρ ⊢ e₂ ⇓ v₂`,
   * and `ρ' ⊢ body[x:=v₂] ⇓ v`.  The body re-evaluation re-parses the
   * closure's body substring under `ρ'.extend(x, v₂)` — the higher-order
   * attribute.
   *
   * Dynamic-semantics step rule E-App: the function position must evaluate
   * to a closure (a value), and the body must evaluate under the extended
   * environment. The `@requires` premise states the function is a closure;
   * the `@ensures` conclusion states the result is a value.
   */
  @requires(
    (_self, fn, _arg) => fn instanceof Closure,
    {
      rule: "E-App",
      formula: "ρ ⊢ e₁ ⇓ ⟨x,τ,span,ρ'⟩",
      description: "the function position evaluates to a closure (a value)",
    },
  )
  @ensures(
    (_self, _args, _old, result) => isValueOrPlaceholder(result),
    {
      rule: "E-App",
      formula: "ρ ⊢ e₁ e₂ ⇓ v",
      description: "the application evaluates to a value",
    },
  )
  protected override app(fn: Value, arg: Value): Value {
    if (!(fn instanceof Closure)) throw new Error(`cannot apply non-function`);
    const bodyEnv = fn.env.extend(fn.param, arg);
    // Re-parse the body substring under bodyEnv. Save/restore _inputOffset
    // so spans captured inside the re-parse are absolute (relative to _input).
    const savedOffset = this._inputOffset;
    this._inputOffset = fn.bodySpan.start;
    try {
      const results = [...this._forward(
        this._input,
        fn.bodySpan,
        this.exprProd(bodyEnv),
      )];
      if (results.length === 0) throw new Error(`stuck application`);
      return results[0]!;
    } finally {
      this._inputOffset = savedOffset;
    }
  }

  /**
   * Dynamic-semantics step rule E-Var: the variable must be bound in the
   * value environment; the result is the bound value.
   */
  @requires(
    (_self, name, ctx) =>
      ctx instanceof ValEnv && ctx.lookup(name) !== undefined,
    {
      rule: "E-Var",
      formula: "ρ(x) = v",
      description: "the variable must be bound in the value environment",
    },
  )
  @ensures(
    (_self, _args, _old, result) => isValueOrPlaceholder(result),
    {
      rule: "E-Var",
      formula: "ρ ⊢ x ⇓ v",
      description: "the variable evaluates to its bound value",
    },
  )
  protected override varRef(name: string, ctx: unknown): Value {
    const v = (ctx as ValEnv).lookup(name);
    if (v === undefined) throw new Error(`unbound variable: ${name}`);
    return v;
  }

  /**
   * Dynamic-semantics value rule E-Bool: a boolean literal is a value.
   */
  @ensures(
    (_self, _args, _old, result) => typeof result === "boolean",
    {
      rule: "E-Bool",
      formula: "b ⇓ b",
      description: "a boolean literal is a value",
    },
  )
  protected override boolLit(b: boolean): Value {
    return b;
  }

  /**
   * Dynamic-semantics value rule E-Int: an integer literal is a value.
   */
  @ensures(
    (_self, _args, _old, result) => typeof result === "number",
    {
      rule: "E-Int",
      formula: "n ⇓ n",
      description: "an integer literal is a value",
    },
  )
  protected override intLit(n: number): Value {
    return n;
  }

  protected override paren(e: Value): Value {
    return e;
  }

  /**
   * Dynamic-semantics value rule E-Abs conclusion: a lambda abstraction
   * evaluates to a closure (a value). This action is never called at runtime
   * (`lambdaProd` is overridden to capture the body span), but its
   * `@ensures` metadata is read by `collectRules` to expose the E-Abs
   * conclusion for the metatheory engine.
   */
  @ensures(
    (_self, _args, _old, result) => isValueOrPlaceholder(result),
    {
      rule: "E-Abs",
      formula: "λx:τ. body ⇓ ⟨x,τ,span,ρ⟩",
      description: "a lambda abstraction evaluates to a closure (a value)",
    },
  )
  protected override lam(_param: string, _type: Type, _body: Value): Value {
    throw new Error(
      "lam() unreachable — STLCEval overrides lambdaProd; this action exists only for @ensures metadata",
    );
  }

  /**
   * Dynamic-semantics step rule E-Let conclusion: a let-binding evaluates to
   * the body's value. This action is never called at runtime (`letProd` is
   * overridden to thread the def value), but its `@ensures` metadata is read
   * by `collectRules` to expose the E-Let conclusion for the metatheory
   * engine.
   */
  @ensures(
    (_self, _args, _old, result) => isValueOrPlaceholder(result),
    {
      rule: "E-Let",
      formula: "ρ ⊢ let x:τ = def in body ⇓ v",
      description: "the let-binding evaluates to the body's value",
    },
  )
  protected override let_(
    _name: string,
    _type: Type,
    _def: Value,
    _body: Value,
  ): Value {
    throw new Error(
      "let_() unreachable — STLCEval overrides letProd; this action exists only for @ensures metadata",
    );
  }

  /**
   * Override `lambdaProd` to capture the body's input span in a closure
   * instead of evaluating the body. The body is parsed under a placeholder
   * env (so `x` is bound and the parse succeeds), but only the **span** is
   * kept — the body's value is discarded. The real evaluation happens when
   * the closure is applied (`app` re-parses the substring).
   *
   * Dynamic-semantics value rule E-Abs: a lambda abstraction evaluates to a
   * closure (a value). The production is tagged with the E-Abs rule name so
   * `collectRules` links it to the E-Abs conclusion (declared on the `lam`
   * action override below).
   */
  @rule({ rule: "E-Abs", production: "lambdaProd" })
  protected override lambdaProd(ctx: unknown): Parser<Value> {
    return seq(
      this.sseq(
        this.lambdaHead,
        this.ident,
        char(":"),
        this.type,
        char("."),
      ),
      this.ws,
    ).chain(([[, param, , ty]]) => {
      assert(typeof param === "string", "lambda param must be a string");
      assert(
        ty instanceof TVar || ty instanceof TFun,
        "lambda type must be a Type",
      );
      // Parse the body under a placeholder env (x bound to PLACEHOLDER) so the
      // parse succeeds; capture the span, discard the value.
      const placeholderCtx = this.extendCtx(ctx, param, ty);
      return this.exprProd(placeholderCtx)
        .map((_body, span) =>
          new Closure(
            param,
            ty,
            {
              start: span.start + this._inputOffset,
              end: span.end + this._inputOffset,
            },
            ctx as ValEnv,
          )
        );
    }).map(([, result]) => result);
  }

  /**
   * Override `letProd` to parse the body under the real env (extended with
   * def's value). Unlike `lambdaProd`, the body is evaluated in the same
   * pass — `def`'s value is available from the `chain`, so the body parser
   * runs under `ρ[name:=def]` directly. No span capture or `_forward` needed.
   *
   * Dynamic-semantics step rule E-Let: `def` evaluates to a value `v₁`, then
   * the body evaluates under `ρ[x:=v₁]`. The production is tagged with the
   * E-Let rule name so `collectRules` links it to the E-Let conclusion
   * (declared on the `let_` action override below).
   */
  @rule({ rule: "E-Let", production: "letProd" })
  protected override letProd(ctx: unknown): Parser<Value> {
    return seq(
      literal("let"),
      this.ws1,
      this.ident,
      this.ws,
      char(":"),
      this.ws,
      this.type,
      this.ws,
      char("="),
      this.ws,
    ).chain(([, , name]) =>
      // Parse def under the outer ctx.
      this.exprProd(ctx)
        .map((def) => ({ name, def }))
        .chain(({ name, def }) =>
          seq(this.ws1, literal("in"), this.ws1)
            .chain(() => {
              // Body parsed under ρ[name:=def] — same pass, no re-parse.
              const bodyCtx = (ctx as ValEnv).extend(name, def);
              return this.exprProd(bodyCtx)
                .map((body) => body);
            })
            .map(([, result]) => result)
        )
        .map(([, result]) => result)
    ).map(([, result]) => result);
  }
}

/* ======================================================================
 *  Concrete: proof-bearing type checker  — `expr(Γ): Parser<TypedTerm>`
 * ====================================================================== */

/** Proof-bearing type checker — returns `TypedTerm` carrying derived types and sub-derivations. */
export class STLCTyped extends AbstractSTLCActions<
  { expr: TypedTerm; atom: TypedTerm; type: Type }
> {
  parseWith(input: string, env: TypeEnv): Set<TypedTerm> {
    return this._parseWith(input, this.exprProd(env));
  }

  override start(): Parser<TypedTerm> {
    return this.exprProd(TypeEnv.empty());
  }

  protected override extendCtx(
    ctx: unknown,
    name: string,
    type: Type,
  ): unknown {
    return (ctx as TypeEnv).extend(name, type);
  }

  protected lam(param: string, type: Type, body: TypedTerm): TypedTerm {
    return new TypedLam(param, type, body);
  }
  protected app(fn: TypedTerm, arg: TypedTerm): TypedTerm {
    // Not used — App is handled via chain in appProd override.
    if (!(fn.type instanceof TFun)) return undefined as unknown as TypedTerm;
    return new TypedApp(fn, arg, fn.type.cod);
  }
  protected let_(
    name: string,
    type: Type,
    def: TypedTerm,
    body: TypedTerm,
  ): TypedTerm {
    return new TypedLet(name, type, def, body);
  }
  protected varRef(name: string, ctx: unknown): TypedTerm {
    const ty = (ctx as TypeEnv).lookup(name);
    if (!ty) return undefined as unknown as TypedTerm;
    return new TypedVar(name, ty);
  }
  protected boolLit(b: boolean): TypedTerm {
    return new TypedBool(b);
  }
  protected intLit(n: number): TypedTerm {
    return new TypedInt(n);
  }
  protected paren(e: TypedTerm): TypedTerm {
    return e;
  }

  @rule
  protected override appProd(ctx: unknown): Parser<TypedTerm> {
    return or(
      this.appProd(ctx)
        .map((fnTT) => ({ fnTT }))
        .chain(({ fnTT }) =>
          seq(this.ws1, this.atomProd(ctx))
            .map(([, argTT]) => ({ fnTT, argTT }))
            .chain(({ fnTT, argTT }) => {
              if (
                !(fnTT.type instanceof TFun) ||
                !typeEq(fnTT.type.dom, argTT.type)
              ) {
                return empty<TypedTerm>();
              }
              return epsilon<TypedTerm>(
                new TypedApp(fnTT, argTT, fnTT.type.cod),
              );
            })
            .map(([, result]) => result)
        )
        .map(([, result]) => result),
      this.atomProd(ctx) as Parser<TypedTerm>,
    );
  }
}
