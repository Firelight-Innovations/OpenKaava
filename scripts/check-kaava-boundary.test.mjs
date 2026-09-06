import { describe, expect, it } from "vitest";
import { groupByRoot, violations } from "./check-kaava-boundary.mjs";

const ROOT = "crates/schematify-core/fixtures/saas-backend/.kaava";
const UUID = "01a03637-7800-70c9-b11e-623a79220e17";
const OTHER_UUID = "01a03637-7800-70ca-a26c-0e6bdbd66fab";

describe("groupByRoot", () => {
  it("classifies nodes/ and runs/ files under their .kaava root", () => {
    const roots = groupByRoot([
      `${ROOT}/nodes/${UUID}.json`,
      `${ROOT}/runs/${UUID}/audit.json`,
      `${ROOT}/edges/some-edge.json`, // irrelevant tree, ignored
      "README.md", // outside any .kaava tree, ignored
    ]);
    expect(roots.size).toBe(1);
    const entry = roots.get(ROOT);
    expect(entry.nodes).toEqual([{ path: `${ROOT}/nodes/${UUID}.json`, uuid: UUID }]);
    expect(entry.runs).toEqual([
      { path: `${ROOT}/runs/${UUID}/audit.json`, uuid: UUID, rest: "audit.json" },
    ]);
  });

  /**
   * The case this file's own header calls out — "a project opened at the
   * repository root would add a fourth" — and the case the patterns could not
   * see until 2026-09-06, because `.*\/\.kaava` demands a slash before
   * `.kaava`. It failed open: no match, no group, no violation, no output.
   */
  it("classifies a .kaava tree at the repository root", () => {
    const roots = groupByRoot([`.kaava/nodes/${UUID}.json`, `.kaava/runs/${UUID}/audit.json`]);
    expect(roots.size).toBe(1);
    const entry = roots.get(".kaava");
    expect(entry.nodes).toEqual([{ path: `.kaava/nodes/${UUID}.json`, uuid: UUID }]);
    expect(entry.runs).toEqual([
      { path: `.kaava/runs/${UUID}/audit.json`, uuid: UUID, rest: "audit.json" },
    ]);
  });

  it("keeps two .kaava roots separate", () => {
    const otherRoot = "crates/schematify-core/fixtures/dense-service/.kaava";
    const roots = groupByRoot([
      `${ROOT}/nodes/${UUID}.json`,
      `${otherRoot}/runs/${OTHER_UUID}/audit.json`,
    ]);
    expect(roots.size).toBe(2);
    expect(roots.get(ROOT).nodes).toHaveLength(1);
    expect(roots.get(ROOT).runs).toHaveLength(0);
    expect(roots.get(otherRoot).nodes).toHaveLength(0);
    expect(roots.get(otherRoot).runs).toHaveLength(1);
  });
});

describe("violations", () => {
  it("passes a pull request that only writes nodes/", () => {
    expect(violations([`${ROOT}/nodes/${UUID}.json`, `${ROOT}/nodes/${OTHER_UUID}.json`])).toEqual(
      [],
    );
  });

  it("passes a pull request that only writes runs/", () => {
    expect(
      violations([`${ROOT}/runs/${UUID}/audit.json`, `${ROOT}/runs/${UUID}/bench.json`]),
    ).toEqual([]);
  });

  /**
   * The acceptance condition PRD §6.3 names by name: a lifecycle transition
   * writes exactly one node file and appends exactly that node's audit row,
   * and the gate must pass that pair.
   */
  it("passes the lifecycle pair: one node, its own audit.json, nothing else", () => {
    expect(violations([`${ROOT}/nodes/${UUID}.json`, `${ROOT}/runs/${UUID}/audit.json`])).toEqual(
      [],
    );
  });

  /**
   * The shape a port of this repository actually produces: generate the
   * semantic tree, then run `kaava reconcile`, which writes one
   * `reconcile.json` per node under `runs/`. That is a design write and an
   * audit write in one commit, and it is what the gate exists to stop — but it
   * could not stop it at the repository root while the patterns demanded a
   * leading directory.
   */
  it("blocks a repository-root port that committed reconcile output beside its nodes", () => {
    expect(
      violations([
        `.kaava/nodes/${UUID}.json`,
        `.kaava/nodes/${OTHER_UUID}.json`,
        `.kaava/runs/${UUID}/reconcile.json`,
      ]),
    ).not.toEqual([]);
  });

  it("blocks a mixed write that is not the lifecycle pair — different uuids", () => {
    const found = violations([
      `${ROOT}/nodes/${UUID}.json`,
      `${ROOT}/runs/${OTHER_UUID}/audit.json`,
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].root).toBe(ROOT);
  });

  it("blocks a mixed write that is not the lifecycle pair — extra runs/ file", () => {
    const found = violations([
      `${ROOT}/nodes/${UUID}.json`,
      `${ROOT}/runs/${UUID}/audit.json`,
      `${ROOT}/runs/${UUID}/bench.json`,
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].touched).toContain(`${ROOT}/runs/${UUID}/bench.json`);
  });

  it("blocks a mixed write that is not the lifecycle pair — extra nodes/ file", () => {
    const found = violations([
      `${ROOT}/nodes/${UUID}.json`,
      `${ROOT}/nodes/${OTHER_UUID}.json`,
      `${ROOT}/runs/${UUID}/audit.json`,
    ]);
    expect(found).toHaveLength(1);
  });

  it("blocks a mixed write that is not the lifecycle pair — runs/ file is not audit.json", () => {
    const found = violations([`${ROOT}/nodes/${UUID}.json`, `${ROOT}/runs/${UUID}/reconcile.json`]);
    expect(found).toHaveLength(1);
  });

  it("judges two .kaava roots independently: one clean, one mixed", () => {
    const otherRoot = "crates/schematify-core/fixtures/dense-service/.kaava";
    const found = violations([
      // clean root: nodes/ only
      `${ROOT}/nodes/${UUID}.json`,
      // mixed root: nodes/ and runs/, not the pair
      `${otherRoot}/nodes/${UUID}.json`,
      `${otherRoot}/runs/${OTHER_UUID}/audit.json`,
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].root).toBe(otherRoot);
  });

  it("judges two .kaava roots independently: both hold the lifecycle pair", () => {
    const otherRoot = "crates/schematify-core/fixtures/dense-service/.kaava";
    expect(
      violations([
        `${ROOT}/nodes/${UUID}.json`,
        `${ROOT}/runs/${UUID}/audit.json`,
        `${otherRoot}/nodes/${OTHER_UUID}.json`,
        `${otherRoot}/runs/${OTHER_UUID}/audit.json`,
      ]),
    ).toEqual([]);
  });

  it("ignores files under other semantic trees entirely", () => {
    expect(
      violations([`${ROOT}/edges/e1.json`, `${ROOT}/rules/r1.json`, `${ROOT}/brief.json`]),
    ).toEqual([]);
  });

  it("ignores files outside any .kaava tree", () => {
    expect(violations(["src/shell/panel/Panel.tsx", "README.md"])).toEqual([]);
  });
});
