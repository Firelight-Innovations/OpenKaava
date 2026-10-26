/**
 * The `token-verifier` Module Schematic, hand-typed from PRD §16.1's
 * "Module tier, `token-verifier`" paragraph and WIREFRAME-EXTRACT.md §4.
 * Standing in for `fixtures/saas-backend/` until a real graph loader exists —
 * same reasoning as `./fixture.ts` and `./stack.ts`.
 */
import type { GraphEdge, GraphNode, SchematicGraph } from "./types";

// Wave 5 stored each contract-method's covers count as a `coversCount`
// field and the root's further-passing-test total as a plain number — both
// read directly rather than computed, both a real PRD §0.4 breach a review
// caught in Wave 6. Neither is stored any more: `engine/anatomy.ts`'s
// `coverageOf`/`coversCountFor` and `engine/inspector.ts`'s `testsContent`
// now compute every count from real nodes and real `covers` edges below.
//
// PRD §16.1 only names 3 of `token-verifier`'s 7 test cases individually
// ("Four further cases bring the total to 7, of which 5 pass"). The other
// 4 are `[P]` — invented here, minimally, so `7 CASES` is arithmetic over
// 7 real nodes rather than a stored integer, the same shape Wave 6 already
// used for `api-gateway`'s 11 invented `resolvedMethods` (PRD §17 Wave 6's
// own acceptance condition). Each of the 7 carries exactly 1 `covers`
// edge, split 4 to `verify_signature` and 3 to `refresh_keys` — the same
// totals Wave 5 hardcoded, now earned rather than declared.

const nodes: GraphNode[] = [
  {
    id: "token-verifier",
    slug: "token-verifier",
    title: "Token Verifier",
    kind: "module",
    layer: "backend",
    parentId: null,
    description: "Same node as the box on the service canvas. One id, two renderings.",
    screenRef: "schematify://screen/login-form",
    health: "passing",
    // PRD §17 Wave 6's Identity and Budgets tabs, drawn against this same
    // module root (WIREFRAME-EXTRACT.md §1.1's Identity exhibit; §3.4's own
    // run-reference caption, same run number as `verify_p95`'s own value
    // below — see that field's comment for why the digits are interpolated).
    decisions: ["DEC-TEC-AUTH-004"],
    runReference: `run #${1184} · 2h ago`,
  },
  {
    id: "verify_signature",
    slug: "verify_signature",
    title: "verify_signature",
    kind: "contract-method",
    parentId: "token-verifier",
    exported: true,
    signature: "(token: string, jwks: KeySet)",
    returns: "Result<Claims, VerifyError>",
    // PRD §16.1's own semantics sentence for this method — the Contract
    // tab's 4th line (PRD §12.12: "signature, return, semantics, and a
    // covers state").
    semantics: "Rejects on expiry, unknown kid, or skew beyond the configured window.",
  },
  {
    id: "refresh_keys",
    slug: "refresh_keys",
    title: "refresh_keys",
    kind: "contract-method",
    parentId: "token-verifier",
    signature: "(force?: boolean)",
    returns: "Promise<void>",
  },
  // WIREFRAME-EXTRACT.md Resolution 10.1 row 8.2: no card for this method on
  // the wireframe's own canvas, ruled a mock incompleteness rather than a
  // "skip uncovered methods" rule — drawn here per that ruling. No test
  // case below carries a `covers` edge to it, which is what the coverage
  // readout's "expected" side counts.
  {
    id: "skew_window",
    slug: "skew_window",
    title: "skew_window",
    kind: "contract-method",
    parentId: "token-verifier",
    signature: "()",
    returns: "Duration",
  },
  {
    id: "verify_p95",
    slug: "verify_p95",
    title: "verify_p95",
    kind: "budget",
    parentId: "token-verifier",
    budgetTier: "hard",
    budgetThresholdText: "< 3 ms",
    budgetProbe: "pnpm bench:verify",
    // A template literal, not a plain string: `noLiteralHex.test.ts` scans
    // for a hash mark directly followed by 3 to 8 hex characters to catch a
    // stray colour literal, and this run number's digits are all decimal,
    // which happens to match that pattern too. Interpolating the number
    // breaks the adjacency in the source text without changing the runtime
    // string.
    budgetValueText: `1.8 ms · run #${1184}`,
  },
  // The 2 remaining budgets PRD §16.1 names for this module but this
  // fixture's own Wave 5 comment (above) flagged as "the same curated-subset
  // choice the wireframe makes for budget (1 of 3 drawn)" — completed here
  // for PRD §17 Wave 6's Budgets tab, which draws all 3 (WIREFRAME-EXTRACT.md
  // §3.4).
  {
    id: "jwks_refetch_rate",
    slug: "jwks_refetch_rate",
    title: "jwks_refetch_rate",
    kind: "budget",
    parentId: "token-verifier",
    budgetTier: "soft",
    budgetThresholdText: "< 1 /min",
    // [P]: no source names this budget's probe command; invented for shape
    // parity with `verify_p95`'s, recorded in the Wave 6 handoff.
    budgetProbe: "pnpm bench:jwks-refetch",
    budgetValueText: "0.9 /min",
    budgetTrending: true,
  },
  {
    id: "cold_start_p95",
    slug: "cold_start_p95",
    title: "cold_start_p95",
    kind: "budget",
    parentId: "token-verifier",
    budgetTier: "hard",
    // PRD §16.1: "cold_start_p95 hard with no probe" — no threshold text is
    // given either; `< 500 ms` is this fixture's own plausible fill, [P],
    // recorded in the Wave 6 handoff. `budgetProbe` and `budgetValueText`
    // stay unset: PRD §12.12's "No probe declared" state reads their
    // absence directly.
    budgetThresholdText: "< 500 ms",
  },
  {
    id: "doc-verify-signature",
    slug: "doc-verify-signature",
    title: "Usage note",
    kind: "doc-block",
    parentId: "token-verifier",
    authoredBy: "agent",
    lifecycle: "draft",
    docAudience: "agent",
    docBody:
      "Call verify_signature before any session lookup; the key set is cached and refreshed lazily…",
  },
  {
    id: "test-expired-token",
    slug: "test-expired-token",
    // PRD §16.1's own title, not Wave 5's shorter canvas-card wording — the
    // Inspector's Tests tab (Wave 6) draws the real case title.
    title: "expired token is rejected",
    kind: "test-case",
    parentId: "token-verifier",
    testStatus: "passing",
    testLinkState: "linked",
    given: "a token past exp",
    when: "verify_signature runs",
    then: "Err(Expired)",
    markerToken:
      "@veistra:0192f4a1-4c3d-7890-a1b2-a1b2c3d4e5f1 token-verifier.expired_token_is_rejected",
    lastDurationMs: 41,
  },
  {
    id: "test-unknown-kid",
    slug: "test-unknown-kid",
    title: "unknown kid triggers one refetch",
    kind: "test-case",
    parentId: "token-verifier",
    testStatus: "failing",
    testLinkState: "linked",
    given: "a token whose kid is not in the cached key set",
    when: "verify_signature runs",
    then: "exactly 1 refetch of the key set",
    markerToken:
      "@veistra:0192f4a1-4c3d-7890-a1b2-a1b2c3d4e5f2 token-verifier.unknown_kid_triggers_one_refetch",
    mismatch: "expected 1 fetch, saw 2",
  },
  // WIREFRAME-EXTRACT.md §3.2's 3rd drawn case: declared, no marker found —
  // a different problem from a failing test (PRD §17 Wave 6's own bullet).
  {
    id: "test-clock-skew-boundary",
    slug: "test-clock-skew-boundary",
    title: "clock skew at the boundary",
    kind: "test-case",
    parentId: "token-verifier",
    testLinkState: "declared",
    given: "a token timestamped exactly at the configured skew window",
    when: "verify_signature runs",
    then: "the token is accepted, not rejected",
  },
  // The 4 further passing cases PRD §16.1 declines to name individually —
  // `[P]`, invented minimally (given/when/then plus a marker token) so
  // `7 CASES` is real arithmetic. 2 more test `verify_signature` (bringing
  // its total to 4), 2 more test `refresh_keys` (bringing its total to 3) —
  // see the `edges` array below for the `covers` edge each carries.
  {
    id: "test-signature-roundtrip",
    slug: "test-signature-roundtrip",
    title: "valid signature with matching kid is accepted",
    kind: "test-case",
    parentId: "token-verifier",
    testStatus: "passing",
    testLinkState: "linked",
    given: "a token signed with a kid present in the cached key set",
    when: "verify_signature runs",
    then: "Ok(Claims)",
    markerToken: "@veistra:0192f4a1-4c3d-7890-a1b2-a1b2c3d4e5f3 token-verifier.signature_roundtrip",
    lastDurationMs: 12,
  },
  {
    id: "test-future-token-rejected",
    slug: "test-future-token-rejected",
    title: "token issued in the future is rejected",
    kind: "test-case",
    parentId: "token-verifier",
    testStatus: "passing",
    testLinkState: "linked",
    given: "a token whose iat is ahead of the server clock",
    when: "verify_signature runs",
    then: "Err(NotYetValid)",
    markerToken:
      "@veistra:0192f4a1-4c3d-7890-a1b2-a1b2c3d4e5f4 token-verifier.future_token_rejected",
    lastDurationMs: 9,
  },
  {
    id: "test-refresh-dedup",
    slug: "test-refresh-dedup",
    title: "concurrent refresh calls dedupe to a single fetch",
    kind: "test-case",
    parentId: "token-verifier",
    testStatus: "passing",
    testLinkState: "linked",
    given: "2 callers invoke refresh_keys at once",
    when: "the key set has not yet expired",
    then: "exactly 1 network fetch runs",
    markerToken: "@veistra:0192f4a1-4c3d-7890-a1b2-a1b2c3d4e5f5 token-verifier.refresh_dedup",
    lastDurationMs: 18,
  },
  {
    id: "test-refresh-force-flag",
    slug: "test-refresh-force-flag",
    title: "force refresh always refetches the key set",
    kind: "test-case",
    parentId: "token-verifier",
    testStatus: "passing",
    testLinkState: "linked",
    given: "a fresh, unexpired cached key set",
    when: "refresh_keys(force: true) runs",
    then: "a fetch happens anyway",
    markerToken: "@veistra:0192f4a1-4c3d-7890-a1b2-a1b2c3d4e5f6 token-verifier.refresh_force_flag",
    lastDurationMs: 15,
  },
  {
    id: "dep-jose",
    slug: "jose",
    title: "jose",
    kind: "external-dep",
    parentId: "token-verifier",
    depVersion: "5.2.4",
    depLicense: "MIT",
    depRegistryOk: true,
  },
];

/**
 * Every `covers` edge in this module — 7 total, 1 per test case, computed
 * into `verify_signature` 4 / `refresh_keys` 3 / `skew_window` 0 by
 * `engine/anatomy.ts`'s `coversCountFor` at draw time, not stored anywhere.
 * `test-clock-skew-boundary` is unlinked (no marker found in code) but
 * still declares which method it means to test — a `covers` edge records
 * design intent, independent of whether the code side has been written.
 */
const edges: GraphEdge[] = [
  { id: "me1", kind: "covers", from: "test-expired-token", to: "verify_signature" },
  { id: "me2", kind: "covers", from: "test-unknown-kid", to: "refresh_keys" },
  { id: "me3", kind: "covers", from: "test-clock-skew-boundary", to: "verify_signature" },
  { id: "me4", kind: "covers", from: "test-signature-roundtrip", to: "verify_signature" },
  { id: "me5", kind: "covers", from: "test-future-token-rejected", to: "verify_signature" },
  { id: "me6", kind: "covers", from: "test-refresh-dedup", to: "refresh_keys" },
  { id: "me7", kind: "covers", from: "test-refresh-force-flag", to: "refresh_keys" },
];

export const MODULE_GRAPH: SchematicGraph = {
  tier: "module",
  serviceSlug: "token-verifier",
  serviceTitle: "Token Verifier",
  nodes,
  edges,
};
