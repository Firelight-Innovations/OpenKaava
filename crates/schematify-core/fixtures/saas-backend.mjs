/**
 * The wireframe fixture of PRD section 16.1, authored node for node.
 *
 * Every named node in that section exists here under the slug the section
 * gives it, so a built screen and its wireframe hold the same words. What is
 * not authored is any count: the badges the wireframe draws (`4 modules`,
 * `11 exports`, `2 dependents`) are computed from this graph at draw time, and
 * this file's job is to make the graph produce them.
 *
 * Four places where a drawn number cannot follow from the drawn content are
 * recorded in the wave 1b handoff rather than papered over here. The rule from
 * PRD section 0.4 decides each of them the same way: the computed value is the
 * truth and the wireframe carries the conflict.
 */

import { Fixture } from "./fixture.mjs";

/** The four libraries of the derived tech stack, with their module counts. */
const LIBRARIES = [
  { name: "jose", version: "5.2.4", license: "MIT", modules: 6 },
  { name: "zod", version: "3.23.8", license: "MIT", modules: 14 },
  { name: "argon2", version: "0.31", license: "Apache-2.0", modules: 2 },
  { name: "postgres", version: "3.4", license: "Unlicense", modules: 9 },
];

/** The 14 rows the `LINTER` card counts. */
const RULE_STATEMENTS = [
  ["no-unwrap", "No unwrap on a value that came from the filesystem or a user."],
  ["error-enum-per-domain", "One error enum per bounded domain, never a stringly-typed error."],
  ["module-doc-comment", "Every module opens with a doc comment saying what it is for."],
  ["record-the-alternative", "A rejected alternative is recorded where the choice was made."],
  ["no-commented-code", "Commented-out code is deleted rather than kept."],
  ["typed-boundaries", "A boundary takes an unknown and narrows it immediately."],
  ["no-any", "No any in application code."],
  ["tests-beside-source", "A test lives beside the module it covers."],
  ["bug-fix-carries-a-test", "A bug fix arrives with the test that would have caught it."],
  ["tokens-not-hex", "A colour is a token reference, never a literal hex value."],
  ["one-node-per-file", "Design data is one node per file, written atomically."],
  ["append-only-audit", "An audit row is appended and never edited."],
  ["marker-token-on-linked-code", "Code with a design counterpart carries its marker token."],
  ["no-sequential-ids", "An identifier is a UUIDv7, never a sequential or path-derived value."],
];

/** The audit history of `token-verifier`, oldest row first. */
const AUDIT_ROWS = [
  ["2026-08-19T10:00:00Z", "draft", "specified", "human", "j.okonkwo", "Written up."],
  ["2026-08-21T15:31:00Z", "specified", "assigned", "human", "j.okonkwo", "Handed to agent."],
  ["2026-08-22T11:00:00Z", "assigned", "implemented", "agent", "claude-sdd", "First pass linked."],
  ["2026-08-23T14:00:00Z", "implemented", "reviewed", "human", "j.okonkwo", "Opened for review."],
  [
    "2026-08-24T09:05:00Z",
    "reviewed",
    "specified",
    "human",
    "j.okonkwo",
    "Bounced: skew tolerance was unspecified.",
  ],
  [
    "2026-08-24T12:40:00Z",
    "specified",
    "assigned",
    "human",
    "j.okonkwo",
    "Re-handed to agent after the bounce.",
  ],
  [
    "2026-08-24T22:18:00Z",
    "assigned",
    "implemented",
    "agent",
    "claude-sdd",
    "All declared tests linked. 1 failing, flagged not asserted.",
  ],
  [
    "2026-08-25T11:40:00Z",
    "implemented",
    "reviewed",
    "human",
    "m.ross",
    "Contract amended during review.",
  ],
  [
    "2026-08-25T14:02:00Z",
    "reviewed",
    "accepted",
    "human",
    "m.ross",
    "Result type resolves the throw-on-expiry ambiguity.",
  ],
];

/** Build and write `fixtures/saas-backend/`. */
export function buildSaasBackend() {
  const f = new Fixture("saas-backend", 0x5aa5_0001);

  f.brief = {
    product_name: "saas-backend",
    problem: "Every product rebuilds the same account, session and billing layer from scratch.",
    users: ["Platform engineers", "Product teams shipping on top of the platform"],
    goals: ["One authentication path", "One billing ledger", "One event bus"],
    non_goals: ["A hosted product", "A public API for third parties"],
    constraints: ["Postgres only", "No shared database between services"],
    success_metrics: [
      { name: "verify_p95", value: 3, unit: "ms" },
      { name: "cold_start_p95", value: 800, unit: "ms" },
    ],
  };

  const libraries = LIBRARIES.map((entry) => ({
    id: f.mint(),
    name: entry.name,
    version: entry.version,
    license: entry.license,
    rationale: `Approved for ${entry.modules} modules of this stack.`,
    decision: null,
  }));
  f.libraries = libraries;
  const lib = Object.fromEntries(libraries.map((entry) => [entry.name, entry.id]));

  const decision = {
    id: f.mint(),
    kind: "decision",
    slug: "DEC-TEC-AUTH-004",
    title: "Verify signatures against a rotating key set",
    context: "The prior design pinned one signing key.",
    decision: "Schematify shall verify against the published key set.",
    consequences: "Key rotation adds a network fetch to the cold path.",
    status: "ACTIVE",
    supersedes: null,
    superseded_by: null,
    date: "2026-08-19",
  };
  f.decisions.push(decision);
  const decisionUri = `schematify://decision/${decision.id}`;

  for (const [slug, statement] of RULE_STATEMENTS) {
    f.rules.push({
      id: f.mint(),
      slug,
      statement,
      command: "pnpm verify",
      marker: null,
      severity: "error",
      audit: [],
    });
  }

  const stack = buildStack(f);
  const auth = buildAuthService(f, stack, lib, decisionUri);
  buildOtherServices(f, stack);
  distributeLibraries(f, lib);
  addScreen(f, auth);
  addRunAndAudit(f, auth);
  addLayouts(f, stack, auth);
  leaveOneUncoveredMethod(f);

  return f.write();
}

/**
 * Cover every contract method the Problems panel does not draw a row for.
 *
 * PRD section 16.1 lists exactly one `Contract method with no covers edge`
 * row, against `token-issuer.mint`. Three other methods on modules that
 * declare test cases carried no covers edge either, so rule L11 drew four
 * rows where the wireframe draws one. These three edges take the other three
 * away and leave `mint` standing, which is the row the wave 7 acceptance
 * condition names.
 *
 * They are appended after every other entity is built, so the seeded minter
 * hands the same identifier to everything that came before and a regeneration
 * adds three files rather than rewriting five thousand.
 *
 * The `skew-window` edge is the one that contradicts a drawn detail: section
 * 16.1 also says that method holds 0 covers edges. The two halves of that
 * section cannot both hold, and the wave 7a handoff records why the Problems
 * table is the half that wins.
 */
function leaveOneUncoveredMethod(f) {
  const bySlug = (slug) => f.nodes.find((n) => n.slug === slug);
  const testsOf = (module) =>
    f.nodes.filter((n) => n.kind === "test-case" && n.parent === module.id);

  const issuerTests = testsOf(bySlug("token-issuer"));
  const verifierTests = testsOf(bySlug("token-verifier"));

  f.edge("covers", issuerTests[0], bySlug("issue-pair"));
  f.edge("covers", issuerTests[1], bySlug("refresh-pair"));
  // `clock-skew-at-the-boundary` is the declared case for this method.
  f.edge("covers", verifierTests[2], bySlug("skew-window"));
}

function buildStack(f) {
  const apiGateway = f.node("service", "api-gateway", "API Gateway", {
    layer: "edge",
    lifecycle: "specified",
    fields: {
      entry_point: "Listens on :8443 behind the load balancer, one process per node.",
      exports: [],
      schemas: null,
    },
  });
  const platformCore = f.node("group", "platform-core", "Platform Core", {
    fields: { color: "accent-1", members: [], collapsed: false },
  });
  const authService = f.node("service", "auth-service", "Auth Service", {
    layer: "backend",
    lifecycle: "accepted",
    parent: platformCore.id,
    fields: { entry_point: "Started by the platform supervisor.", exports: [], schemas: null },
  });
  const sessionService = f.node("service", "session-service", "Session Service", {
    layer: "data",
    parent: platformCore.id,
    fields: { entry_point: "Started by the platform supervisor.", exports: [], schemas: null },
  });
  const billingService = f.node("service", "billing-service", "Billing Service", {
    layer: "backend",
    fields: { entry_point: "Started by the platform supervisor.", exports: [], schemas: null },
  });
  const notificationService = f.node("service", "notification-service", "Notification Service", {
    lifecycle: "draft",
    fields: { exports: [] },
  });
  const ledgerStore = f.node("service", "ledger-store", "Ledger Store", {
    layer: "data",
    parent: sessionService.id,
    fields: {
      entry_point: "Started with the session service.",
      exports: [],
      schemas: "./schema/ledger.sql",
    },
  });
  const eventBus = f.node("service", "event-bus", "Event Bus", {
    lifecycle: "accepted",
    fields: { entry_point: "Started before every consumer.", exports: [] },
  });

  platformCore.members = [authService.id, sessionService.id];

  f.edge("depends_on", apiGateway, authService);
  f.edge("depends_on", apiGateway, billingService);
  f.edge("depends_on", authService, eventBus);
  f.edge("depends_on", sessionService, eventBus);
  f.edge("depends_on", billingService, eventBus);
  f.edge("depends_on", notificationService, eventBus);
  f.edge("depends_on", billingService, ledgerStore);

  return {
    apiGateway,
    platformCore,
    authService,
    sessionService,
    billingService,
    notificationService,
    ledgerStore,
    eventBus,
  };
}

function buildAuthService(f, stack, lib, decisionUri) {
  const service = stack.authService;
  const module = (slug, title, extra = {}) =>
    f.node("module", slug, title, { parent: service.id, ...extra });

  const httpEntry = module("http-entry", "HTTP Entry", {
    description: "Terminates the request and routes it into the service.",
    fields: { allowed_libraries: [], ui_refs: [] },
  });
  const tokenIssuer = module("token-issuer", "Token Issuer", {
    description: "Mints access and refresh pairs, binds them to a session record.",
    fields: { allowed_libraries: [lib.jose, lib.zod], ui_refs: [] },
  });
  const tokenVerifier = module("token-verifier", "Token Verifier", {
    description: "Verifies JWT signatures against the rotating key set.",
    lifecycle: "accepted",
    decisions: [decisionUri],
    fields: { allowed_libraries: [lib.jose], ui_refs: [] },
  });
  const jwksCache = f.node("module", "jwks-cache", "JWKS Cache", {
    parent: tokenVerifier.id,
    description: "Holds the remote key set and refreshes it lazily.",
    fields: { allowed_libraries: [], ui_refs: [] },
  });
  const clockSkew = f.node("module", "clock-skew", "Clock Skew", {
    parent: tokenVerifier.id,
    lifecycle: "draft",
    description: "Tolerates a bounded difference between issuer and verifier clocks.",
    fields: { allowed_libraries: [], ui_refs: [] },
  });
  const sessionStore = module("session-store", "Session Store", {
    description: "Owns the session record and its revocation.",
    fields: { allowed_libraries: [], ui_refs: [] },
  });
  const sessionCodec = f.node("module", "session-codec", "Session Codec", {
    parent: sessionStore.id,
    description: "Encodes and decodes the session envelope.",
    fields: { allowed_libraries: [], ui_refs: [] },
  });
  const sessionIndex = f.node("module", "session-index", "Session Index", {
    parent: sessionStore.id,
    description: "Indexes sessions by subject and by device.",
    fields: { allowed_libraries: [], ui_refs: [] },
  });
  const cryptoPrimitives = module("crypto-primitives", "Crypto Primitives", {
    lifecycle: "accepted",
    description: "Signing, hashing and constant-time comparison.",
    fields: { allowed_libraries: [], ui_refs: [] },
  });
  const passwordHasher = module("password-hasher", "Password Hasher", {
    description: "Argon2id hashing with per-tenant cost parameters.",
    lifecycle: "reviewed",
    fields: { allowed_libraries: [lib.argon2], ui_refs: [] },
  });
  const rateLimiter = module("rate-limiter", "Rate Limiter", {
    description: "Pre-filled by agent. Not reviewed.",
    lifecycle: "draft",
    authored_by: "agent",
    fields: { allowed_libraries: [], ui_refs: [] },
  });
  const auditEmitter = module("audit-emitter", "Audit Emitter", {
    description: "Emits an audit event for every credential decision.",
    lifecycle: "stale",
    fields: { allowed_libraries: [], ui_refs: [] },
  });
  // PRD section 7.4 draws a second caption line naming what moved under this
  // node. The source is token-verifier rather than the crypto-primitives the
  // wireframe names, for the reason the handoff gives under conflict 3: the
  // drawn dependent count and the drawn cause cannot both hold, and the count
  // is the one the wireframe computes.
  auditEmitter.stale = {
    source: tokenVerifier.id,
    member: "verify-signature",
    at: "2026-08-25T11:40:00Z",
  };

  f.edge("depends_on", httpEntry, tokenIssuer);
  f.edge("depends_on", httpEntry, tokenVerifier);
  f.edge("depends_on", tokenIssuer, sessionStore);
  f.edge("depends_on", sessionStore, sessionCodec);
  f.edge("depends_on", sessionCodec, tokenIssuer);
  f.edge("depends_on", jwksCache, cryptoPrimitives);
  f.edge("depends_on", clockSkew, cryptoPrimitives);
  f.edge("depends_on", auditEmitter, tokenVerifier);
  f.edge("depends_on", rateLimiter, sessionIndex);

  const facets = buildTokenVerifierFacets(f, tokenVerifier, lib);
  const issuePair = buildTokenIssuerFacets(f, tokenIssuer);
  buildBulkFacets(f, cryptoPrimitives, { methods: 6, tests: 14, budgets: 1 });
  buildBulkFacets(f, jwksCache, { methods: 2, tests: 6, budgets: 0 });

  const revoke = contractMethod(f, sessionStore, "revoke", {
    signature: "revoke(session: SessionId)",
    params: ["session: SessionId"],
    returns: "Promise<void>",
    semantics: "Marks the session revoked and emits an audit event.",
    exported: true,
  });
  const checkPassword = contractMethod(f, passwordHasher, "check-password", {
    signature: "check_password(candidate: string, stored: Hash)",
    params: ["candidate: string", "stored: Hash"],
    returns: "Promise<boolean>",
    semantics: "Constant-time comparison against a stored Argon2id hash.",
    exported: true,
  });

  service.exports = [facets.verifySignature.id, issuePair.id, revoke.id, checkPassword.id];

  const group = f.node("group", "token-pipeline", "Token pipeline", {
    parent: service.id,
    fields: {
      color: "accent-2",
      members: [tokenIssuer.id, tokenVerifier.id],
      collapsed: false,
    },
  });
  const comment = f.node("comment", "two-caches-on-purpose", "Two caches here on purpose", {
    parent: service.id,
    fields: {
      body: "Two caches here on purpose - the JWKS one is remote-backed, the skew one is not. Don't merge.",
      author: "m.ross",
      anchor: tokenVerifier.id,
    },
  });

  // Deliberately illegal, so linter rule L05 has something to find in the
  // fixture: an annotation node carrying a semantic edge.
  f.edge("covers", comment, facets.verifySignature);

  return {
    service,
    group,
    comment,
    tokenVerifier,
    tokenIssuer,
    cryptoPrimitives,
    auditEmitter,
    ...facets,
  };
}

function buildTokenVerifierFacets(f, tokenVerifier, lib) {
  const verifySignature = contractMethod(f, tokenVerifier, "verify-signature", {
    signature: "verify_signature(token: string, jwks: KeySet)",
    params: ["token: string", "jwks: KeySet"],
    returns: "Result<Claims, VerifyError>",
    errors: ["VerifyError::Expired", "VerifyError::UnknownKid", "VerifyError::Skew"],
    semantics: "Rejects on expiry, unknown kid, or skew beyond the configured window.",
    exported: true,
  });
  const refreshKeys = contractMethod(f, tokenVerifier, "refresh-keys", {
    signature: "refresh_keys(force?: boolean)",
    params: ["force?: boolean"],
    returns: "Promise<void>",
    semantics: "Refetches the key set, unconditionally when forced.",
    exported: false,
  });
  contractMethod(f, tokenVerifier, "skew-window", {
    signature: "skew_window()",
    params: [],
    returns: "Duration",
    semantics: "Reports the configured tolerance.",
    exported: false,
  });

  const cases = [
    ["expired-token-is-rejected", "an expired token", "passing", 41],
    ["unknown-kid-triggers-one-refetch", "a token signed by an unknown kid", "failing", null],
    ["clock-skew-at-the-boundary", "a token one second outside the window", "declared", null],
    ["a-valid-token-yields-claims", "a well-formed token", "passing", 12],
    ["a-forced-refresh-refetches", "a forced refresh", "passing", 88],
    ["a-lazy-refresh-is-skipped", "a fresh key set", "passing", 4],
    ["a-refetch-failure-surfaces", "an unreachable key endpoint", "passing", 31],
  ];
  const tests = cases.map(([slug, given, status, ms]) =>
    f.node("test-case", slug, slug.replaceAll("-", " "), {
      parent: tokenVerifier.id,
      fields: {
        given,
        when: "the module is exercised",
        then: "the declared behaviour holds",
        impl_ref: status === "declared" ? null : `@veistra:${tokenVerifier.id} token-verifier`,
        status,
        last_result_ms: ms,
      },
    }),
  );

  // Four covers edges onto verify_signature and three onto refresh_keys.
  // `skew_window` is covered as well, by `leaveOneUncoveredMethod` at the end
  // of the build, which is where every remaining covers edge is added.
  //
  // Section 16.1 contradicts itself here. Its module-tier paragraph says
  // `skew_window` holds 0 covers edges; its Problems table draws exactly one
  // L11 row, against `token-issuer.mint`. Both cannot hold, because L11 fires
  // on an uncovered contract method and this module declares seven test cases.
  // The wave 7 acceptance condition names the five Problems rows as the thing
  // a test asserts, and nothing asserts the module-tier prose, so the table is
  // the half that wins and this method carries a covers edge.
  for (const test of tests.slice(0, 4)) {
    f.edge("covers", test, verifySignature);
  }
  for (const test of tests.slice(4)) {
    f.edge("covers", test, refreshKeys);
  }

  f.node("budget", "verify-p95", "verify_p95", {
    parent: tokenVerifier.id,
    fields: {
      metric: "verify_p95",
      op: "<",
      value: 3,
      unit: "ms",
      tier: "hard",
      probe: { command: "pnpm bench:verify", parser: "veistra-bench-v1" },
      sign_off: null,
    },
  });
  f.node("budget", "jwks-refetch-rate", "jwks_refetch_rate", {
    parent: tokenVerifier.id,
    fields: {
      metric: "jwks_refetch_rate",
      op: "<",
      value: 1,
      unit: "per minute",
      tier: "soft",
      probe: { command: "pnpm bench:jwks", parser: "veistra-bench-v1" },
      sign_off: "m.ross, run #1179",
    },
  });
  // No probe, so linter rule L03 fires. The wireframe draws that row.
  f.node("budget", "cold-start-p95", "cold_start_p95", {
    parent: tokenVerifier.id,
    fields: {
      metric: "cold_start_p95",
      op: "<",
      value: 800,
      unit: "ms",
      tier: "hard",
      probe: null,
      sign_off: null,
    },
  });

  f.node("doc-block", "verify-before-lookup", "Verify before any session lookup", {
    parent: tokenVerifier.id,
    authored_by: "agent",
    fields: {
      body: "Call verify_signature before any session lookup; the key set is cached and refreshed lazily.",
      audience: "agent",
    },
  });
  f.node("external-dep", "jose-use", "jose 5.2.4", {
    parent: tokenVerifier.id,
    fields: { registry_ref: lib.jose, usage_note: "MIT, registry ok." },
  });

  return { verifySignature, refreshKeys };
}

function buildTokenIssuerFacets(f, tokenIssuer) {
  const issuePair = contractMethod(f, tokenIssuer, "issue-pair", {
    signature: "issue_pair(subject: SubjectId)",
    params: ["subject: SubjectId"],
    returns: "Promise<TokenPair>",
    semantics: "Mints an access and refresh pair bound to one session record.",
    exported: true,
  });
  // No covers edge, so linter rule L11 fires. The wireframe draws that row.
  contractMethod(f, tokenIssuer, "mint", {
    signature: "mint(claims: Claims)",
    params: ["claims: Claims"],
    returns: "Promise<string>",
    semantics: "Signs one token.",
    exported: false,
  });
  contractMethod(f, tokenIssuer, "refresh-pair", {
    signature: "refresh_pair(refresh: string)",
    params: ["refresh: string"],
    returns: "Promise<TokenPair>",
    semantics: "Exchanges a refresh token for a new pair.",
    exported: false,
  });

  for (let i = 0; i < 5; i += 1) {
    f.node("test-case", `token-issuer-case-${i + 1}`, `Token issuer case ${i + 1}`, {
      parent: tokenIssuer.id,
      fields: {
        given: "a subject",
        when: "a pair is issued",
        then: "the pair binds to one session",
        impl_ref: `@veistra:${tokenIssuer.id} token-issuer`,
        status: "passing",
        last_result_ms: 9 + i,
      },
    });
  }
  for (const [slug, metric] of [
    ["issue-p95", "issue_p95"],
    ["refresh-p95", "refresh_p95"],
  ]) {
    f.node("budget", slug, metric, {
      parent: tokenIssuer.id,
      fields: {
        metric,
        op: "<",
        value: 5,
        unit: "ms",
        tier: "hard",
        probe: { command: `pnpm bench:${metric}`, parser: "veistra-bench-v1" },
        sign_off: null,
      },
    });
  }

  return issuePair;
}

function buildBulkFacets(f, module, { methods, tests, budgets }) {
  const made = [];
  for (let i = 0; i < methods; i += 1) {
    made.push(
      contractMethod(f, module, `${module.slug}-method-${i + 1}`, {
        signature: `${module.slug.replaceAll("-", "_")}_${i + 1}()`,
        params: [],
        returns: "Promise<void>",
        semantics: "Declared on this module.",
        exported: false,
      }),
    );
  }
  for (let i = 0; i < tests; i += 1) {
    const test = f.node("test-case", `${module.slug}-case-${i + 1}`, `Case ${i + 1}`, {
      parent: module.id,
      fields: {
        given: "the module",
        when: "it is exercised",
        then: "the declared behaviour holds",
        impl_ref: `@veistra:${module.id} ${module.slug}`,
        status: "passing",
        last_result_ms: 5 + i,
      },
    });
    // Every declared method keeps at least one covers edge, so rule L11 fires
    // only where the wireframe draws it.
    if (made.length > 0) {
      f.edge("covers", test, made[i % made.length]);
    }
  }
  for (let i = 0; i < budgets; i += 1) {
    const metric = `${module.slug.replaceAll("-", "_")}_p95`;
    f.node("budget", `${module.slug}-p95`, metric, {
      parent: module.id,
      fields: {
        metric,
        op: "<",
        value: 2,
        unit: "ms",
        tier: "hard",
        probe: { command: `pnpm bench:${metric}`, parser: "veistra-bench-v1" },
        sign_off: null,
      },
    });
  }
  return made;
}

function contractMethod(f, parent, slug, fields) {
  return f.node("contract-method", slug, slug.replaceAll("-", "_"), {
    parent: parent.id,
    fields: { errors: [], ...fields },
  });
}

/**
 * The four remaining services, sized so the module and export counts the
 * wireframe draws come out of the graph rather than out of a field.
 */
function buildOtherServices(f, stack) {
  const shapes = [
    { service: stack.apiGateway, modules: 4, exports: 11 },
    { service: stack.sessionService, modules: 6, exports: 2 },
    { service: stack.billingService, modules: 9, exports: 6 },
    { service: stack.ledgerStore, modules: 2, exports: 3 },
    { service: stack.notificationService, modules: 2, exports: 0 },
    { service: stack.eventBus, modules: 2, exports: 0 },
  ];

  for (const { service, modules, exports } of shapes) {
    const made = [];
    for (let i = 0; i < modules; i += 1) {
      made.push(
        f.node("module", `${service.slug}-module-${i + 1}`, `${service.title} module ${i + 1}`, {
          parent: service.id,
          description: `One module of ${service.title}.`,
          layer: service.layer ?? null,
          fields: { allowed_libraries: [], ui_refs: [] },
        }),
      );
    }
    const published = [];
    for (let i = 0; i < exports; i += 1) {
      const host = made[i % made.length];
      published.push(
        contractMethod(f, host, `${service.slug}-export-${i + 1}`, {
          signature: `${service.slug.replaceAll("-", "_")}_${i + 1}()`,
          params: [],
          returns: "Promise<void>",
          semantics: "Published across the service boundary.",
          exported: true,
        }).id,
      );
    }
    service.exports = published;
  }
}

/**
 * Spread `allowed_libraries` so the derived tech stack draws the counts of
 * PRD section 16.1: jose 6, zod 14, argon2 2, postgres 9.
 *
 * The named modules keep the libraries the wireframe puts on them, and the
 * remainder is filled from the rest of the stack in slug order, so the
 * assignment is deterministic and a rebuild moves nothing.
 */
function distributeLibraries(f, lib) {
  const modules = f.nodes.filter((n) => n.kind === "module");
  const counts = Object.fromEntries(LIBRARIES.map((entry) => [entry.name, entry.modules]));

  for (const module of modules) {
    for (const [name, id] of Object.entries(lib)) {
      if (module.allowed_libraries?.includes(id)) {
        counts[name] -= 1;
      }
    }
  }

  const spare = modules
    .filter((m) => (m.allowed_libraries ?? []).length === 0)
    .sort((a, b) => a.slug.localeCompare(b.slug));

  let at = 0;
  for (const [name, id] of Object.entries(lib)) {
    for (let i = 0; i < counts[name]; i += 1) {
      const module = spare[at % spare.length];
      at += 1;
      if (!module.allowed_libraries.includes(id)) {
        module.allowed_libraries.push(id);
      }
    }
  }
}

function addScreen(f, auth) {
  const screen = {
    id: f.mint(),
    kind: "screen",
    slug: "login-form",
    title: "Login form",
    purpose: "Collects credentials and starts a session.",
    states: ["empty", "filled", "submitting", "error", "locked"],
    acceptance: ["A locked account shall show the recovery path."],
    design_ref: "https://claude.ai/design/p/522c739c-b021-4cce-b8a2-ae11c9f3353d",
    backed_by: [`schematify://node/${auth.tokenVerifier.id}`],
  };
  f.screens.push(screen);

  f.edge("references_ui", auth.tokenVerifier, { id: screen.id });
  // The cache follows the edge, per PRD section 5.11. The edge is
  // authoritative and this array is written from it.
  auth.tokenVerifier.ui_refs = [`schematify://screen/${screen.id}`];

  f.flows.push({
    id: f.mint(),
    kind: "flow",
    slug: "first-run-signup",
    title: "First-run signup",
    trigger: "A visitor opens the product with no account.",
    steps: [
      {
        screen: `schematify://screen/${screen.id}`,
        action: "The visitor enters an email address.",
      },
      { screen: `schematify://screen/${screen.id}`, action: "The visitor sets a password." },
    ],
    outcome: "The visitor holds an active session.",
  });
}

function addRunAndAudit(f, auth) {
  f.runs.push({
    node: auth.tokenVerifier.id,
    run: {
      schema: "veistra-bench-v1",
      run: 1184,
      at: "2026-08-25T14:02:00Z",
      commit: "4f2c9ab",
      workflow: "ci/verify.yml",
      budgets: [
        { metric: "verify_p95", value: 1.8, unit: "ms", pass: true },
        { metric: "jwks_refetch_rate", value: 0.9, unit: "per minute", pass: true },
        { metric: "cold_start_p95", value: 940, unit: "ms", pass: false },
      ],
      tests: [
        { impl_ref: "@veistra:expired-token-is-rejected", status: "passing", ms: 41 },
        { impl_ref: "@veistra:unknown-kid-triggers-one-refetch", status: "failing" },
        { impl_ref: "@veistra:clock-skew-at-the-boundary", status: "declared" },
        { impl_ref: "@veistra:a-valid-token-yields-claims", status: "passing", ms: 12 },
        { impl_ref: "@veistra:a-forced-refresh-refetches", status: "passing", ms: 88 },
        { impl_ref: "@veistra:a-lazy-refresh-is-skipped", status: "passing", ms: 4 },
        { impl_ref: "@veistra:a-refetch-failure-surfaces", status: "passing", ms: 31 },
      ],
      linter: { rules: 14, violations: 0 },
      reconcile: { matched: 7, declared_absent: 1, present_unknown: 0, duplicate: 0 },
    },
  });

  f.audits.push({
    node: auth.tokenVerifier.id,
    rows: AUDIT_ROWS.map(([at, from, to, actor, actor_name, reason]) => ({
      node: auth.tokenVerifier.id,
      at,
      from,
      to,
      actor,
      actor_name,
      reason,
    })),
  });
}

function addLayouts(f, stack, auth) {
  const place = (values, zoom) => {
    const layout = { schematic: "", zoom, pan: [0, 0], nodes: {}, groups: {} };
    values.forEach((value, index) => {
      const target = value.kind === "group" ? layout.groups : layout.nodes;
      target[value.id] = {
        x: 80 + (index % 4) * 280,
        y: 80 + Math.floor(index / 4) * 200,
        w: 240,
        h: 140,
        collapsed: false,
      };
    });
    return layout;
  };

  const stackLayout = place(Object.values(stack), 1);
  stackLayout.schematic = "stack";
  f.layouts.push(stackLayout);

  const authModules = f.nodes.filter((n) => n.kind === "module" && n.parent === auth.service.id);
  const authLayout = place([...authModules, auth.group], 0.68);
  authLayout.schematic = "auth-service";
  f.layouts.push(authLayout);
}
