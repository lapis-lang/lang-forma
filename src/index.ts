/**
 * Public entry point for the `@lapis-lang/lang-forma` package.
 * See the README for the full API documentation.
 */

export { Grammar, rule } from "./Grammar.ts";
export type { Diagnostic, GrammarShape } from "./Grammar.ts";
export {
  FixpointDivergenceError,
  MonotonicityViolationError,
} from "./Grammar.ts";
export { Parser, parserOf } from "./Parser.ts";
export type { AttributionKind, Checkpoint } from "./Parser.ts";
export { ZipperDriver } from "./zipper.ts";
export type { Pos, Span, Tok } from "./zipper.ts";

export {
  between,
  bind,
  chain,
  char,
  diagnostic,
  empty,
  epsilon,
  keyword,
  literal,
  or,
  plus,
  pred,
  sepBy,
  sepByPlus,
  sepByStar,
  seq,
  sseq,
  star,
  trim,
} from "./combinators.ts";

export {
  digit,
  digits,
  ident,
  identChar,
  identFirst,
  identRest,
  ws,
  ws1,
  wsChar,
} from "./lexemes.ts";

export {
  assert,
  assertInvariants,
  AssertionError,
  chainMetadata,
  collectMetadata,
  ContractError,
  ensures,
  findRescueHandler,
  getCheckedMode,
  iff,
  implies,
  invariant,
  metadataOf,
  requires,
  rescue,
  setCheckedMode,
} from "./contracts.ts";
export type {
  ContractMeta,
  ContractMetadata,
  ContractMetadataReport,
  EnsuresContract,
  EnsuresPredicate,
  InvariantContract,
  InvariantPredicate,
  MethodMetadataReport,
  OldSnapshot,
  ParseFailure,
  RequiresContract,
  RequiresPredicate,
  RescueHandler,
} from "./contracts.ts";

/* ── Retained derivation trees + semantic passes ── */
export {
  buildDerivationTrees,
  DerivationNode,
  DerivationTree,
  SemanticPass,
} from "./derivation.ts";
export type { DerivationRecord } from "./derivation.ts";

/* ── First-class inference rules ── */
export {
  classifyRule,
  classifyRules,
  collectRules,
  formatRule,
} from "./rules.ts";
export type {
  ClassifiedRule,
  FormattedInferenceRule,
  InferenceRule,
  RuleClause,
  RuleKind,
  RuleRole,
} from "./rules.ts";

/* ── Metatheory verification ── */
export {
  checkPreservation,
  checkProgress,
  verifyMetatheory,
} from "./metatheory.ts";
export type {
  MetatheoryReport,
  PreservationCheck,
  PreservationResult,
  ProgressGap,
  ProgressResult,
} from "./metatheory.ts";

/* ── Generative counterexample search ── */
export { findCounterexamples } from "./counterexamples.ts";
export type {
  Counterexample,
  CounterexampleOptions,
  CounterexampleResult,
} from "./counterexamples.ts";

/* ── Yield-Kanren (relational unification engine) ── */
export {
  atom,
  conj,
  conjAll,
  disj,
  disjAll,
  eq,
  fresh,
  parseType,
  run,
  runExists,
  Substitution,
  Term,
  term,
  unify,
  Var,
} from "./kanren.ts";
export type { Goal, LogicValue } from "./kanren.ts";

/* ── Top-down generation ── */
export { DEFAULT_ALPHABET, GenerationError, Generator } from "./generate.ts";
export type {
  BranchStrategy,
  GeneratorOptions,
  GeneratorResult,
} from "./generate.ts";

/* ── Native property-based testing ── */
export { GrammarGenerator, PropertyFailure } from "./property.ts";
export type {
  ForAllOptions,
  ForAllResult,
  ValueGenerator,
} from "./property.ts";

/* ── Unparsing (inverse parsing) ── */
export { unparse, UnparsePass } from "./unparse.ts";
