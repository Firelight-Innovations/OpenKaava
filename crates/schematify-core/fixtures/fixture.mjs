/**
 * The shared machinery every Schematify fixture is built with.
 *
 * The identifiers are UUIDv7-shaped and deliberately not minted by the crate.
 * A fixture is test input, and test input that changes every time it is built
 * cannot be reviewed. The layout still matches RFC 9562 - version nibble,
 * variant bits, a timestamp that sorts - so the loader treats them exactly as
 * it treats real ones, and a rebuild produces an empty diff.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The instant every generated identifier is stamped with. */
const BASE_MS = Date.parse("2026-08-25T00:00:00Z");

/** An RFC 3339 timestamp used wherever a fixture needs a creation date. */
const CREATED = "2026-08-25T00:00:00Z";

/** Deterministic 32-bit noise, so a rebuild produces identical bytes. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A UUIDv7-shaped identifier from a seeded stream.
 *
 * The counter climbs through the twelve `rand_a` bits and then borrows a
 * millisecond, which is the monotonic scheme `IdMinter` uses in the crate. Two
 * ids from one minter therefore sort in the order they were handed out, which
 * is what makes a generated fixture's node order stable.
 */
function makeMinter(seed) {
  const random = mulberry32(seed);
  let ms = BASE_MS;
  let counter = 0;

  return function mint() {
    if (counter > 0xfff) {
      ms += 1;
      counter = 0;
    }
    const bytes = new Uint8Array(16);
    const stamp = BigInt(ms);
    for (let i = 0; i < 6; i += 1) {
      bytes[i] = Number((stamp >> BigInt(8 * (5 - i))) & 0xffn);
    }
    bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
    bytes[7] = counter & 0xff;
    for (let i = 8; i < 16; i += 1) {
      bytes[i] = Math.floor(random() * 256);
    }
    bytes[8] = 0x80 | (bytes[8] & 0x3f);
    counter += 1;

    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  };
}

/** One fixture under construction, and every collection it will write. */
class Fixture {
  constructor(name, seed) {
    this.root = join(here, name);
    this.mint = makeMinter(seed);
    this.nodes = [];
    this.edges = [];
    this.screens = [];
    this.flows = [];
    this.decisions = [];
    this.rules = [];
    this.libraries = [];
    this.layouts = [];
    this.runs = [];
    this.audits = [];
    this.brief = null;
  }

  node(kind, slug, title, extra = {}) {
    const { fields = {}, ...envelope } = extra;
    const value = {
      id: this.mint(),
      slug,
      kind,
      title,
      lifecycle: "specified",
      authored_by: "human",
      created: CREATED,
      superseded_by: null,
      parent: null,
      ...envelope,
      ...fields,
    };
    this.nodes.push(value);
    return value;
  }

  edge(kind, source, target) {
    const value = {
      id: this.mint(),
      kind,
      source: source.id,
      target: target.id,
      created: CREATED,
      superseded_by: null,
    };
    this.edges.push(value);
    return value;
  }

  write() {
    rmSync(this.root, { recursive: true, force: true });
    const veistra = join(this.root, ".veistra");

    writeCollection(join(veistra, "nodes"), this.nodes);
    writeCollection(join(veistra, "edges"), this.edges);
    writeCollection(join(veistra, "screens"), this.screens);
    writeCollection(join(veistra, "flows"), this.flows);
    writeCollection(join(veistra, "decisions"), this.decisions);
    writeCollection(join(veistra, "rules"), this.rules);

    mkdirSync(join(veistra, "registry"), { recursive: true });
    writeJson(join(veistra, "registry", "libraries.json"), { libraries: this.libraries });

    mkdirSync(join(veistra, "layout"), { recursive: true });
    for (const layout of this.layouts) {
      writeJson(join(veistra, "layout", `${layout.schematic}.json`), layout);
    }

    for (const { node, run } of this.runs) {
      writeJson(join(veistra, "runs", node, `run-${run.run}.json`), run);
    }
    for (const { node, rows } of this.audits) {
      writeJson(join(veistra, "runs", node, "audit.json"), rows);
    }
    if (this.brief) {
      writeJson(join(veistra, "brief.json"), this.brief);
    }

    return {
      nodes: this.nodes.length,
      edges: this.edges.length,
      files:
        this.nodes.length +
        this.edges.length +
        this.screens.length +
        this.flows.length +
        this.decisions.length +
        this.rules.length,
    };
  }
}

function writeCollection(directory, values) {
  mkdirSync(directory, { recursive: true });
  for (const value of values) {
    writeJson(join(directory, `${value.id}.json`), value);
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export { Fixture, CREATED, writeJson };
