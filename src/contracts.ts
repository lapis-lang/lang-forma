/**
 * Design-by-contract decorators for grammar semantic actions.
 * See the README for the full introduction.
 *
 * @module
 */

/* ======================================================================
 *  Errors
 * ====================================================================== */

/** Thrown by `assert()` on assertion failure. */
export class AssertionError extends Error {
  constructor(message = "Assertion Error") {
    super(message);
    this.name = "AssertionError";
  }
}

/** Thrown by `@ensures`/`@invariant` on contract violation. */
export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

/* ======================================================================
 *  Logical primitives
 * ====================================================================== */

/**
 * Inline assertion; throws `AssertionError` on failure, narrows `c`'s type.
 * Use for bugs, not parse failures (use `@requires` for those).
 */
export function assert(
  condition: unknown,
  message = "Assertion Error",
): asserts condition {
  if (Boolean(condition) === false) {
    throw new AssertionError(message);
  }
}

/** Material implication `!p || q`. */
export function implies(p: boolean, q: boolean): boolean {
  return !p || q;
}

/** Biconditional `(p && q) || (!p && !q)`. */
export function iff(p: boolean, q: boolean): boolean {
  return (p && q) || (!p && !q);
}

/* ======================================================================
 *  Checked mode
 * ====================================================================== */

/**
 * Global default for contract checking. New `Grammar` instances inherit
 * this value at construction time; per-instance overrides are stored in
 * {@link instanceCheckedMode}. Toggle the default with
 * {@link setCheckedMode} / {@link getCheckedMode}.
 */
let globalCheckedMode = true;

/** Per-instance override for contract checking. */
const instanceCheckedMode = new WeakMap<object, boolean>();

/**
 * Returns `true` if contract checks are enabled for `instance` (the default).
 * Falls back to {@link globalCheckedMode} when no per-instance override is
 * set.
 */
function checkedModeFor(instance: object): boolean {
  return instanceCheckedMode.get(instance) ?? globalCheckedMode;
}

/**
 * Set the per-instance checked-mode override on `instance`.
 */
function setCheckedModeFor(instance: object, enabled: boolean): void {
  instanceCheckedMode.set(instance, enabled);
}

/**
 * Returns the global default for contract checking (applied to new
 * `Grammar` instances at construction).
 *
 * @returns `true` if contract checks are enabled by default.
 */
export function getCheckedMode(): boolean {
  return globalCheckedMode;
}

/** Toggle the global default for contract enforcement. Applies live to all instances. */
export function setCheckedMode(enabled: boolean): void {
  globalCheckedMode = enabled;
}

/**
 * Run `fn` with contract checking disabled for `self`.
 * Restores prior state on exit.
 */
function withoutChecks<T>(instance: object, fn: () => T): T {
  const hadOverride = instanceCheckedMode.has(instance);
  const prior = checkedModeFor(instance);
  setCheckedModeFor(instance, false);
  try {
    return fn();
  } finally {
    if (hadOverride) {
      setCheckedModeFor(instance, prior);
    } else {
      // Remove the temporary override so the instance falls back to the
      // global default again (avoiding pinning the global value as a
      // permanent per-instance override).
      instanceCheckedMode.delete(instance);
    }
  }
}

/* ======================================================================
 *  Contract metadata (Symbol.metadata)
 * ====================================================================== */
//
// Subcontracting: @invariant AND-ed, @requires OR-ed, @ensures AND-ed across inheritance.
//
// Each contract is stored as a `{ predicate, meta? }` pair so that the
// executable predicate and the declarative metadata are co-located and
// cannot drift apart. Both are exposed reflectively via `collectMetadata`.

/**
 * Arbitrary, schema-less metadata attached to a contract via the optional
 * second argument of `@requires` / `@ensures` / `@invariant` / `@rule`.
 *
 * The library imposes no structure on this object — it stores and
 * round-trips it opaquely. Authors choose their own keys (e.g.
 * `{ rule: "T-App", formula: "..." }` for a PL grammar, or entirely
 * different keys for a JSON/CSV grammar). Downstream tooling reads
 * whatever keys the author established.
 */
export type ContractMeta = Record<string, unknown>;

/** A `@requires` precondition paired with its optional declarative metadata. */
export interface RequiresContract {
  /** Executable predicate — the runtime check. */
  predicate: RequiresPredicate;
  /** Declarative metadata supplied via `@requires(pred, meta)`. */
  meta?: ContractMeta;
}

/** A `@ensures` postcondition paired with its optional declarative metadata. */
export interface EnsuresContract {
  /** Executable predicate — the runtime check. */
  predicate: EnsuresPredicate;
  /** Declarative metadata supplied via `@ensures(pred, meta)`. */
  meta?: ContractMeta;
}

/** A `@invariant` class invariant paired with its optional declarative metadata. */
export interface InvariantContract {
  /** Executable predicate — the runtime check. */
  predicate: InvariantPredicate;
  /** Declarative metadata supplied via `@invariant(pred, meta)`. */
  meta?: ContractMeta;
}

/** Metadata shape stored on each contracted class via `Symbol.metadata`. */
export interface ContractMetadata {
  /** Class invariants — AND-ed across the inheritance chain. */
  invariants: InvariantContract[];
  /** Per-feature preconditions — OR-ed across the inheritance chain. */
  requires: Record<PropertyKey, RequiresContract[]>;
  /** Per-feature postconditions — AND-ed across the inheritance chain. */
  ensures: Record<PropertyKey, EnsuresContract[]>;
  /** Per-feature rescue handlers — inherited unless overridden. */
  rescue: Record<PropertyKey, RescueHandler>;
  /**
   * Per-feature `@rule` production metadata — set by `Grammar`'s `@rule`
   * decorator. The value is the `meta` object passed to `@rule(meta)`, or
   * `undefined` for a bare `@rule`. Presence of a key (even `undefined`)
   * marks the feature as a production (`isRule: true` in the report).
   */
  ruleMeta: Record<PropertyKey, ContractMeta | undefined>;
}

/**
 * Private symbol under which {@link ContractMetadata} is stored on a class's
 * `Symbol.metadata` object. Using a dedicated key avoids conflicting with
 * other decorators that may share `Symbol.metadata`.
 */
const CONTRACTS = Symbol.for("@lapis-lang/lang-forma/contracts");

/**
 * Retrieve (or initialise) the {@link ContractMetadata} stored on a given
 * `Symbol.metadata` object (the `ctx.metadata` passed to a decorator).
 *
 * A subclass's `Symbol.metadata` prototypically inherits from its parent's
 * (per the TC39 decorator metadata spec), so a naive `store[CONTRACTS]`
 * lookup would find the *parent's* `ContractMetadata` via the prototype
 * chain and mutate it — corrupting the parent and double-counting contracts
 * in the chain walk. We therefore check for an **own** property and create
 * a fresh per-class `ContractMetadata` when absent.
 */
export function metaOn(symMeta: object): ContractMetadata {
  const store = symMeta as Record<symbol, unknown>;
  if (Object.prototype.hasOwnProperty.call(store, CONTRACTS)) {
    return store[CONTRACTS] as ContractMetadata;
  }
  const fresh: ContractMetadata = {
    invariants: [],
    requires: {},
    ensures: {},
    rescue: {},
    ruleMeta: {},
  };
  store[CONTRACTS] = fresh;
  return fresh;
}

/**
 * Retrieve (or initialise) the {@link ContractMetadata} stored on a class
 * constructor's `Symbol.metadata`. Returns `undefined` if the class has no
 * metadata object (e.g. it was never decorated).
 */
export function metadataOf(
  Class: abstract new (...args: unknown[]) => unknown,
): ContractMetadata | undefined {
  const symMeta = (Class as unknown as { [Symbol.metadata]?: object })[
    Symbol.metadata
  ];
  if (!symMeta) return undefined;
  return metaOn(symMeta);
}

/**
 * Walk the prototype chain of `instance`'s class and collect every
 * `ContractMetadata` (most-derived first). Used to evaluate inherited
 * contracts for subcontracting and to aggregate reflective metadata.
 */
export function* chainMetadata(
  instance: object,
): Generator<ContractMetadata> {
  let proto = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    const meta = metadataOf(
      proto.constructor as abstract new (...args: unknown[]) => unknown,
    );
    if (meta) yield meta;
    proto = Object.getPrototypeOf(proto);
  }
}

/**
 * Walk the constructor chain of `Class` (most-derived first) and collect
 * every `ContractMetadata`. Unlike {@link chainMetadata} (which starts
 * from an instance's prototype), this starts from `Class` itself — used by
 * the static `Grammar.metadata` getter so the class's own contracts are
 * included.
 */
export function* chainMetadataOfClass(
  Class: abstract new (...args: unknown[]) => unknown,
): Generator<ContractMetadata> {
  let ctor: abstract new (...args: unknown[]) => unknown = Class;
  // Walk the constructor chain most-derived first, stopping at `Function`
  // (the root constructor, i.e. `Object.prototype.constructor`) — beyond
  // it lies `Function.prototype` which has no contract metadata.
  while (ctor && ctor !== Object.prototype.constructor) {
    const meta = metadataOf(ctor);
    if (meta) yield meta;
    ctor = Object.getPrototypeOf(ctor) as abstract new (
      ...args: unknown[]
    ) => unknown;
  }
}

/* ======================================================================
 *  Predicate types
 * ====================================================================== */

/** A class invariant predicate: `(self) => boolean`. */
export type InvariantPredicate<This = unknown> = (self: This) => boolean;

/**
 * Generic function bound used as the default `F` for predicate generics.
 * Keeps unannotated predicates compiling while letting an explicit method
 * type drive `Parameters<F>` / `ReturnType<F>` inference.
 */
// deno-lint-ignore no-explicit-any
type AnyFn = (...args: any[]) => unknown;

/**
 * The keys of `This` whose values are *not* functions — i.e. the data
 * fields that {@link snapshotOld} copies as own enumerable string-keyed
 * properties. Prototype methods and getters are not own properties, so
 * `Object.keys` never returns them; arrow-function fields *are* own data
 * properties and are copied, but they are function-valued so they appear
 * in {@link FnKeys} instead (see {@link OldSnapshot}).
 */
type DataKeys<This> =
  & {
    [K in keyof This]-?: This[K] extends (...a: never[]) => unknown ? never : K;
  }[keyof This]
  & (string | symbol);

/**
 * The keys of `This` whose values *are* functions. These cover both
 * prototype methods (absent from the runtime snapshot — not own props) and
 * arrow-function fields (present in the runtime snapshot — own enumerable
 * data props). TypeScript cannot distinguish the two at the type level, so
 * {@link OldSnapshot} marks them *optional* to stay honest.
 */
type FnKeys<This> =
  & {
    [K in keyof This]-?: This[K] extends (...a: never[]) => unknown ? K : never;
  }[keyof This]
  & (string | symbol);

/**
 * Honest shape of the `old` value passed to `@ensures` predicates: a plain
 * object holding the own enumerable string-keyed properties of `This` as
 * they were before the method body ran.
 *
 * - **Data fields** (non-function-valued own props) are *required* — they
 *   are always copied by {@link snapshotOld}.
 * - **Function-valued keys** (methods, getters, arrow-function fields) are
 *   *optional* — TypeScript cannot distinguish own arrow-function fields
 *   (present at runtime) from prototype methods/getters (absent at
 *   runtime), so the type is honest about the uncertainty. Accessing such
 *   a key yields `T | undefined`; narrow with `instanceof` or a truthiness
 *   check if you need to call it.
 */
export type OldSnapshot<This> =
  & { [K in DataKeys<This>]: This[K] }
  & { [K in FnKeys<This>]?: This[K] };

/**
 * A precondition predicate: `(self, ...args) => boolean`.
 *
 * `F` is the decorated method's type; `...args` is spread as
 * `Parameters<F>` so the predicate reads positionally. Defaults to a fully
 * generic function so unannotated use still compiles (args `unknown[]`).
 */
export type RequiresPredicate<
  This = unknown,
  F extends AnyFn = (...args: unknown[]) => unknown,
> = (
  self: This,
  ...args: Parameters<F>
) => boolean;

/**
 * A postcondition predicate: `(self, args, old, result) => boolean`.
 *
 * `F` is the decorated method's type; `args` is the whole `Parameters<F>`
 * tuple, `old` is an {@link OldSnapshot} of `This`, and `result` is
 * `ReturnType<F>`. Defaults to a fully generic function so unannotated use
 * still compiles (args `unknown[]`, result `unknown`).
 */
export type EnsuresPredicate<
  This = unknown,
  F extends AnyFn = (...args: unknown[]) => unknown,
> = (
  self: This,
  args: Parameters<F>,
  old: OldSnapshot<This>,
  result: ReturnType<F>,
) => boolean;

/* ======================================================================
 *  @invariant — class decorator
 * ====================================================================== */

/**
 * Class invariant; checked after construction and after each contracted call.
 * AND-ed across inheritance.
 */
export function invariant<
  This extends abstract new (...args: unknown[]) => unknown,
>(
  predicate: InvariantPredicate<InstanceType<This>>,
  meta?: ContractMeta,
): (value: This, ctx: ClassDecoratorContext<This>) => This {
  const metaArg = meta;
  return (value, ctx) => {
    if (ctx.kind !== "class") {
      throw new ContractError("@invariant can only decorate a class");
    }
    // Write to the class's Symbol.metadata directly in the decorator body
    // so the metadata is available statically (without instantiation).
    const store = metaOn(ctx.metadata);
    store.invariants = [
      ...store.invariants,
      { predicate: predicate as InvariantPredicate, meta: metaArg },
    ];
    return value;
  };
}

/**
 * Append a `{ predicate, meta? }` pair to the named `table` (`requires` /
 * `ensures`) under `key`, creating the array if absent. Shared by
 * `@requires` / `@ensures`.
 */
function registerPredicate(
  meta: ContractMetadata,
  table: "requires" | "ensures",
  key: PropertyKey,
  predicate: RequiresPredicate | EnsuresPredicate,
  metaObj?: ContractMeta,
): void {
  const existing = meta[table][key] ?? [];
  meta[table][key] = [...existing, { predicate, meta: metaObj }];
}

/**
 * Collect every predicate declared for `prop` under `table` across the
 * whole inheritance chain (most-derived first). Shared by the Proxy
 * `get` trap and `assertInvariants`. Yields the executable predicate from
 * each `{ predicate, meta? }` pair.
 */
function* collectPredicates(
  target: object,
  table: "requires" | "ensures" | "invariants",
  prop?: PropertyKey,
): Generator<RequiresPredicate | EnsuresPredicate | InvariantPredicate> {
  for (const meta of chainMetadata(target)) {
    const contracts = prop === undefined
      ? meta.invariants
      : (meta[table] as Record<PropertyKey, { predicate: unknown }[]>)[prop] ??
        [];
    for (const c of contracts) yield c.predicate as RequiresPredicate;
  }
}

/**
 * Format a contract-violation message naming the class (and optionally the
 * feature). Shared by `assertInvariants` and the `@ensures` check.
 */
function violationMessage(
  target: object,
  kind: "Invariant" | "Postcondition",
  prop?: PropertyKey,
): string {
  const Class = target.constructor;
  const where = prop === undefined ? "" : `.${String(prop)}`;
  return `${kind} violated on ${Class.name}${where}`;
}

/**
 * Wrap `target` in the contract-enforcement `Proxy`, or return it unchanged
 * when `checkedMode` is disabled. Called from `Grammar`'s constructor so
 * the contracts layer owns the Proxy-creation decision.
 */
export function wrapWithContracts<T extends object>(target: T): T {
  if (!checkedModeFor(target)) return target;
  return new Proxy(target, contractProxyHandler) as unknown as T;
}

/**
 * Evaluate all invariants (AND-ed across the inheritance chain) on
 * `instance`. Throws {@link ContractError} if any invariant is violated.
 * No-op when `checkedMode` is disabled.
 */
export function assertInvariants(instance: object): void {
  const err = tryInvariants(instance);
  if (err !== null) throw err;
}

/**
 * Like {@link assertInvariants} but returns the error instead of throwing
 * (or `null` if all invariants hold). Used inside `finally` blocks where
 * throwing is unsafe (no-unsafe-finally).
 */
function tryInvariants(instance: object): ContractError | null {
  if (!checkedModeFor(instance)) return null;
  return withoutChecks(instance, () => {
    for (const inv of collectPredicates(instance, "invariants")) {
      if (!(inv as InvariantPredicate)(instance)) {
        return new ContractError(violationMessage(instance, "Invariant"));
      }
    }
    return null;
  });
}

/* ======================================================================
 *  @requires — precondition decorator (graceful failure)
 * ====================================================================== */

/**
 * Precondition; on failure returns `undefined` — the value flows into the
 * parse forest (nothing prunes it). The production path must check the
 * premise and return `empty()` for rejection. OR-ed across inheritance.
 * The predicate's `...args` are typed as `Parameters` of the decorated
 * method — inferred, no manual annotation.
 */
export function requires<
  This extends object,
  M extends AnyFn = AnyFn,
>(
  predicate: RequiresPredicate<This, M>,
  meta?: ContractMeta,
): (
  target: M,
  ctx: ClassMethodDecoratorContext<This, M>,
) => void {
  const metaArg = meta;
  return (_target, ctx) => {
    if (ctx.kind !== "method") {
      throw new ContractError("@requires can only decorate a method");
    }
    // Write to the class's Symbol.metadata directly in the decorator body
    // so the metadata is available statically (without instantiation).
    registerPredicate(
      metaOn(ctx.metadata),
      "requires",
      ctx.name,
      predicate as RequiresPredicate,
      metaArg,
    );
  };
}

/* ======================================================================
 *  @ensures — postcondition decorator (throws on violation)
 * ====================================================================== */

/**
 * Postcondition `(self, args, old, result) => boolean`; throws `ContractError`
 * on failure. AND-ed across inheritance. The predicate's `args`/`result` are
 * typed as `Parameters`/`ReturnType` of the decorated method — inferred, no
 * manual annotation needed.
 */
export function ensures<
  This extends object,
  M extends AnyFn = AnyFn,
>(
  predicate: EnsuresPredicate<This, M>,
  meta?: ContractMeta,
): (
  target: M,
  ctx: ClassMethodDecoratorContext<This, M>,
) => void {
  const metaArg = meta;
  return (_target, ctx) => {
    if (ctx.kind !== "method") {
      throw new ContractError("@ensures can only decorate a method");
    }
    // Write to the class's Symbol.metadata directly in the decorator body
    // so the metadata is available statically (without instantiation).
    registerPredicate(
      metaOn(ctx.metadata),
      "ensures",
      ctx.name,
      predicate as EnsuresPredicate,
      metaArg,
    );
  };
}

/**
 * Shallow snapshot of an object's own enumerable *string* keys, used as the
 * `old` value passed to `@ensures` predicates. Returns a plain object with
 * the same own enumerable string-keyed properties. Symbol-keyed properties
 * are not included (they are skipped by `Object.keys`).
 */
function snapshotOld<T>(self: T): OldSnapshot<T> {
  const old: Record<PropertyKey, unknown> = {};
  for (const key of Object.keys(self as unknown as object)) {
    old[key] = (self as unknown as Record<PropertyKey, unknown>)[key];
  }
  return old as unknown as OldSnapshot<T>;
}

/* ======================================================================
 *  @rescue — parse-failure recovery with diagnostics
 * ====================================================================== */

/**
 * Describes why a production's parse yielded an empty forest. Passed to a
 * `@rescue` handler so it can report diagnostics or retry with an
 * alternative strategy.
 */
export interface ParseFailure {
  /** Machine-readable reason category, e.g. `"type-mismatch"`. */
  reason: string;
  /** Human-readable detail. */
  message?: string;
  /** The value that was expected (if applicable). */
  expected?: unknown;
  /** The value that was found (if applicable). */
  actual?: unknown;
  /** 0-based source position of the failure, if known. */
  position?: number;
  /** Name of the production that failed. */
  production: string;
}

/**
 * Parse-failure recovery handler. Invoked when a production yields an empty
 * forest.
 *
 * `M` is the decorated production's type; `args` is `Parameters<M>` —
 * inferred from the method, so no manual annotation is needed. For getter
 * productions `M` is `() => unknown` and `args` is `[]`. Defaults to a fully
 * generic function so unannotated use still compiles (args `unknown[]`).
 */
export type RescueHandler<
  This = object,
  M extends AnyFn = (...args: unknown[]) => unknown,
> = (
  self: This,
  failure: ParseFailure,
  args: Parameters<M>,
  retry?: () => unknown,
) => unknown;

/**
 * Parse-failure recovery; most-derived handler wins.
 * Decorator factory for `@rescue` — accepts both getter and method productions.
 * The handler's `args` are typed as `Parameters` of the decorated production —
 * inferred, no manual annotation needed.
 */
// Method overload: `args` inferred as `Parameters<M>` from the method.
// `ctx` is a union because `@rule` may transform a getter into a function,
// making the stacked decorator appear as a method context at type-check
// time even when `ctx.kind === "getter"` at runtime.
export function rescue<
  This extends object,
  M extends AnyFn = AnyFn,
>(
  handler: RescueHandler<This, M>,
): (
  target: unknown,
  ctx:
    | ClassMethodDecoratorContext<This, M>
    | ClassGetterDecoratorContext<This, unknown>,
) => void;
// Getter overload: getters take no args, so `args` is `[]`.
export function rescue<This extends object>(
  handler: RescueHandler<This, () => unknown>,
): (
  target: unknown,
  ctx: ClassGetterDecoratorContext<object, unknown>,
) => void;
// Implementation signature — maximally accepting; the overloads above
// carry the precise types. `handler` is stored opaquely and invoked via
// `findRescueHandler`, so its exact generic instantiation is erased here.
// `any` is required for the impl so the generic overloads (whose `args`
// tuples vary contravariantly) are all assignable to it.
export function rescue(
  // deno-lint-ignore no-explicit-any
  handler: any,
): (
  target: unknown,
  ctx:
    | ClassGetterDecoratorContext<object, unknown>
    | ClassMethodDecoratorContext<object, (...args: unknown[]) => unknown>,
) => void {
  return (_target, ctx) => {
    if (ctx.kind !== "method" && ctx.kind !== "getter") {
      throw new ContractError("@rescue can only decorate a method or getter");
    }
    // Write to the class's Symbol.metadata directly in the decorator body
    // so the metadata is available statically (without instantiation).
    metaOn(ctx.metadata).rescue[ctx.name] = handler as RescueHandler;
  };
}

/**
 * Look up the rescue handler for `prop` on `target`'s inheritance chain
 * (most-derived wins). Returns `undefined` if none is declared.
 */
export function findRescueHandler(
  target: object,
  prop: PropertyKey,
): RescueHandler | undefined {
  for (const meta of chainMetadata(target)) {
    const h = meta.rescue[prop];
    if (h) return h;
  }
  return undefined;
}

/* ======================================================================
 *  Proxy dispatch — enforces contracts on every method call
 * ====================================================================== */
//
// Proxy dispatches to target, wrapping contracted methods with pre/post checks.

/** Property keys that bypass contract checking (internal helpers, symbols). */
const CONTRACT_SKIP_KEYS = new Set<PropertyKey>([
  "constructor",
  "start", // entry production is a @rule getter; skip
]);

/** Proxy handler enforcing contracts on method calls. */
export const contractProxyHandler: ProxyHandler<object> = {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    // Only intercept function-valued properties (methods). Non-functions
    // (fields, getters returning data) pass through.
    if (typeof value !== "function") return value;
    // Skip internal/constructor keys.
    if (CONTRACT_SKIP_KEYS.has(prop)) return value;
    // Skip @rule productions — they return Parser<T> and are memoised; the
    // contract system targets semantic actions, not productions.
    if (isProduction(value)) return value;

    // If no contract metadata references this method, no wrapping needed.
    if (!hasContracts(target, prop)) return value;

    // When checked mode is off for this instance, return the raw method.
    if (!checkedModeFor(target)) return value;

    return function (this: object, ...args: unknown[]): unknown {
      // Contracts evaluate against `target` (the unwrapped instance) to
      // avoid Proxy re-entry in predicates/snapshots; the method body runs
      // against `this` (the call-site receiver) to preserve normal JS/TS
      // method semantics under `.call`/`.apply`/`.bind`.
      let pendingError: unknown = null;
      try {
        // invariant(before)
        assertInvariants(target);
        // requires (OR-ed across the chain). If ANY is satisfied, proceed.
        // No preconditions at all → always proceed (vacuously true).
        const requiresOk = withoutChecks(target, () => {
          let anyPred = false;
          for (const p of collectPredicates(target, "requires", prop)) {
            anyPred = true;
            if ((p as RequiresPredicate)(target, ...args)) return true;
          }
          // If no @requires predicates exist, the precondition is vacuously true.
          return !anyPred;
        });
        if (!requiresOk) {
          // premise failed → action returns undefined (the value flows
          // into the parse forest; rejection is the production path's
          // job); still check invariant-after
          const invErr = tryInvariants(target);
          if (invErr !== null) throw invErr;
          return undefined;
        }
        // Snapshot `old` before the body for @ensures.
        const old = snapshotOld(target);
        const result = Reflect.apply(value, this, args);
        // ensures (AND-ed across the chain). ALL must hold.
        withoutChecks(target, () => {
          for (const p of collectPredicates(target, "ensures", prop)) {
            if (!(p as EnsuresPredicate)(target, args, old, result)) {
              throw new ContractError(
                violationMessage(target, "Postcondition", prop),
              );
            }
          }
        });
        // invariant(after) on success
        const invErr = tryInvariants(target);
        if (invErr !== null) throw invErr;
        return result;
      } catch (e) {
        pendingError = e;
        // invariant(after) on throw — but the original error wins if the
        // invariant also fails (matches the reference library semantics).
        const invErr = tryInvariants(target);
        if (invErr !== null && pendingError === null) throw invErr;
        throw e;
      }
    };
  },
};

/**
 * Does any class in `target`'s inheritance chain declare a `@requires` or
 * `@ensures` for `prop`? If not, the Proxy `get` trap can skip wrapping.
 */
function hasContracts(target: object, prop: PropertyKey): boolean {
  for (const meta of chainMetadata(target)) {
    if ((meta.requires[prop]?.length ?? 0) > 0) return true;
    if ((meta.ensures[prop]?.length ?? 0) > 0) return true;
  }
  return false;
}

/* ======================================================================
 *  Reflective metadata report
 * ====================================================================== */

/**
 * Per-method reflective entry: the `@requires`/`@ensures` contracts (each
 * exposing both `.predicate` and `.meta`), plus `@rule` production metadata.
 */
export interface MethodMetadataReport {
  /** `@requires` contracts for this method, most-derived first. */
  requires: RequiresContract[];
  /** `@ensures` contracts for this method, most-derived first. */
  ensures: EnsuresContract[];
  /**
   * `@rule` metadata for this production, if it is a `@rule`-decorated
   * feature. `meta` is the object passed to `@rule(meta)`, or `undefined`
   * for a bare `@rule`.
   */
  rule?: { meta?: ContractMeta };
  /** `true` if this feature is a `@rule` production (bare or with meta). */
  isRule: boolean;
}

/**
 * Aggregated, read-only view of a grammar's contracts across its whole
 * inheritance chain (most-derived first). Exposes both the executable
 * predicates and the declarative metadata for each contract, so downstream
 * tooling (documentation generators, test generators, verifiers) can be
 * built on top without the library committing to any specific use case.
 */
export interface ContractMetadataReport {
  /** Per-method contracts, keyed by method name. */
  methods: Record<PropertyKey, MethodMetadataReport>;
  /** Class invariants (most-derived first). */
  invariants: InvariantContract[];
}

/**
 * Build a {@link ContractMetadataReport} by walking an inheritance chain
 * (most-derived first) and merging every class's `ContractMetadata`.
 * `@requires`/`@ensures`/`@invariant` contract arrays are concatenated
 * across the chain; `@rule` production metadata is surfaced per method
 * with `isRule: true`.
 *
 * Both the executable `.predicate` and the declarative `.meta` are exposed
 * on each contract. Predicates are stored unbound — when invoking a
 * predicate from the report, pass the instance as the first (`self`)
 * argument.
 *
 * Accepts either a `Grammar` **instance** (walks its prototype chain) or a
 * `Grammar` **subclass** (walks its constructor chain, starting from the
 * class itself — used by the static `Grammar.metadata` getter).
 */
export function collectMetadata(
  instanceOrClass: object | (abstract new (...args: unknown[]) => unknown),
): ContractMetadataReport {
  const methods: Record<PropertyKey, MethodMetadataReport> = {};
  const invariants: InvariantContract[] = [];
  const chain = typeof instanceOrClass === "function"
    ? chainMetadataOfClass(
      instanceOrClass as abstract new (...args: unknown[]) => unknown,
    )
    : chainMetadata(instanceOrClass);
  for (const meta of chain) {
    for (const inv of meta.invariants) invariants.push(inv);
    // `Reflect.ownKeys` includes symbol keys (which `for...in` misses), so
    // symbol-keyed productions are surfaced in the report just like string-
    // keyed ones. The records are plain `{}` literals (no inherited
    // enumerable props), so own keys are exactly the registered contracts.
    for (const key of Reflect.ownKeys(meta.requires)) {
      const contracts = meta.requires[key as PropertyKey];
      if (!contracts || contracts.length === 0) continue;
      const entry = methods[key as PropertyKey] ??= {
        requires: [],
        ensures: [],
        isRule: false,
      };
      entry.requires = [...entry.requires, ...contracts];
    }
    for (const key of Reflect.ownKeys(meta.ensures)) {
      const contracts = meta.ensures[key as PropertyKey];
      if (!contracts || contracts.length === 0) continue;
      const entry = methods[key as PropertyKey] ??= {
        requires: [],
        ensures: [],
        isRule: false,
      };
      entry.ensures = [...entry.ensures, ...contracts];
    }
    for (const key of Reflect.ownKeys(meta.ruleMeta)) {
      const ruleMetaVal = meta.ruleMeta[key as PropertyKey];
      const entry = methods[key as PropertyKey] ??= {
        requires: [],
        ensures: [],
        isRule: false,
      };
      entry.isRule = true;
      // Most-derived non-undefined @rule meta wins; a bare @rule in a
      // subclass overrides a @rule(meta) in a base only if it explicitly
      // passes undefined — but bare @rule leaves the base's meta intact
      // when the subclass doesn't re-declare @rule at all. Since we walk
      // most-derived first, only set `rule` if not already set.
      if (entry.rule === undefined) {
        entry.rule = { meta: ruleMetaVal };
      }
    }
  }
  return { methods, invariants };
}

/**
 * Sentinel marker applied by `@rule` to its wrapper functions, so the
 * contract Proxy can recognise and skip productions. Set by `Grammar`'s
 * `@rule` decorator via `_markProduction`.
 */
const PRODUCTION = Symbol.for("@lapis-lang/lang-forma/production");

/**
 * Mark a function as a `@rule` production (to be skipped by contract
 * checking). Called by the `@rule` decorator.
 */
export function _markProduction<F extends (...args: unknown[]) => unknown>(
  fn: F,
): F {
  (fn as unknown as Record<symbol, boolean>)[PRODUCTION] = true;
  return fn;
}

/**
 * Is `value` a `@rule` production (marked to skip contract checking)?
 */
function isProduction(value: unknown): boolean {
  return typeof value === "function" &&
    (value as unknown as Record<symbol, unknown>)[PRODUCTION] === true;
}
