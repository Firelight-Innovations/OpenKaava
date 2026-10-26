/**
 * The filenames below carry the shape `tauri build` really produced — PR #20
 * lists `Veistra_0.1.0_x64-setup.exe` and `Veistra_0.1.0_x64_en-US.msi` from a
 * local `pnpm app:build`, and only the version is changed here. That matters:
 * this module's whole job is to agree with a naming scheme nobody in this
 * repository controls, and a fixture written from memory would test the memory.
 */

import { describe, expect, it } from "vitest";
import { buildManifest, classify, defaultNotes, versionOf } from "./update-manifest.mjs";

const SETUP = "Veistra_0.2.0_x64-setup.exe";
const MSI = "Veistra_0.2.0_x64_en-US.msi";
const SIGNED = [{ file: SETUP, signature: "dW50cnVzdGVkIGNvbW1lbnQ=\n" }];

describe("classify", () => {
  it("reads the platform and the installer out of a filename", () => {
    expect(classify(SETUP)).toMatchObject({ target: "windows-x86_64", kind: "nsis" });
    expect(classify(MSI)).toMatchObject({ target: "windows-x86_64", kind: "msi" });
    expect(classify("Veistra_0.2.0_arm64-setup.exe")).toMatchObject({
      target: "windows-aarch64",
    });
  });

  it("claims nothing it cannot name both halves of", () => {
    expect(classify("Veistra-setup.exe")).toBeNull();
    expect(classify("Veistra_0.2.0_x64.exe")).toBeNull();
  });
});

describe("versionOf", () => {
  it("takes the v off a tag, because the manifest carries the bare version", () => {
    expect(versionOf("v0.2.0")).toBe("0.2.0");
    expect(versionOf("0.2.0")).toBe("0.2.0");
    expect(versionOf("v0.2.0-rc.1")).toBe("0.2.0-rc.1");
  });

  it("refuses a tag that is not a version", () => {
    expect(() => versionOf("nightly")).toThrow(/not a version/);
    expect(() => versionOf("v0.2")).toThrow(/not a version/);
  });
});

describe("buildManifest", () => {
  it("points each platform at the asset on the tagged release", () => {
    const manifest = buildManifest({
      tag: "v0.2.0",
      signed: SIGNED,
      pubDate: "2026-01-01T00:00:00Z",
    });

    expect(manifest.version).toBe("0.2.0");
    expect(manifest.pub_date).toBe("2026-01-01T00:00:00Z");
    expect(manifest.platforms["windows-x86_64"]).toEqual({
      signature: "dW50cnVzdGVkIGNvbW1lbnQ=",
      url: `https://github.com/Firelight-Innovations/Veistra/releases/download/v0.2.0/${SETUP}`,
    });
  });

  /** The URL is built from the tag, not from the version, because that is the
   *  path GitHub actually serves the asset on. A prerelease tag makes the two
   *  differ by more than a `v`. */
  it("builds the URL from the tag rather than the version", () => {
    const manifest = buildManifest({ tag: "v0.2.0-rc.1", signed: SIGNED });
    expect(manifest.platforms["windows-x86_64"].url).toContain("/download/v0.2.0-rc.1/");
    expect(manifest.version).toBe("0.2.0-rc.1");
  });

  /** A trailing newline in a `.sig` is what the file on disk really has, and a
   *  signature with one in it fails verification on every machine at once. */
  it("trims the signature the way it comes off disk", () => {
    const manifest = buildManifest({
      tag: "v0.2.0",
      signed: [{ file: SETUP, signature: "  abc\n" }],
    });
    expect(manifest.platforms["windows-x86_64"].signature).toBe("abc");
  });

  it("drops the filename it used, keeping only what the updater reads", () => {
    const entry = buildManifest({ tag: "v0.2.0", signed: SIGNED }).platforms["windows-x86_64"];
    expect(Object.keys(entry).sort()).toEqual(["signature", "url"]);
  });

  it("writes a sentence when the release has no note of its own", () => {
    expect(buildManifest({ tag: "v0.2.0", signed: SIGNED }).notes).toBe(defaultNotes("0.2.0"));
    expect(buildManifest({ tag: "v0.2.0", signed: SIGNED, notes: "Fixes it." }).notes).toBe(
      "Fixes it.",
    );
  });

  /**
   * The failure this whole module exists to prevent. A build that ran without
   * `TAURI_SIGNING_PRIVATE_KEY` produces installers and no `.sig`, and a
   * manifest published from it would advertise an update every machine then
   * refuses to verify — with nothing in the build log to say so.
   */
  it("refuses to publish a manifest about nothing signed", () => {
    expect(() => buildManifest({ tag: "v0.2.0", signed: [] })).toThrow(/TAURI_SIGNING_PRIVATE_KEY/);
    expect(() =>
      buildManifest({ tag: "v0.2.0", signed: [{ file: "notes.txt", signature: "x" }] }),
    ).toThrow(/nothing to publish/);
  });

  /**
   * Not reachable while `bundle.targets` is `["nsis"]`, and covered anyway:
   * that config line is one word from being `"all"`, and then both installers
   * are signed and both claim `windows-x86_64`. NSIS has to win whichever order
   * they are collected in — a manifest that depended on `readdir` order would
   * be a coin flip nobody would notice until an update installed the wrong one.
   */
  it("picks the NSIS setup over the MSI, in either order", () => {
    for (const order of [
      [SETUP, MSI],
      [MSI, SETUP],
    ]) {
      const manifest = buildManifest({
        tag: "v0.2.0",
        signed: order.map((file) => ({ file, signature: file })),
      });
      expect(manifest.platforms["windows-x86_64"].url).toContain(SETUP);
      expect(manifest.platforms["windows-x86_64"].signature).toBe(SETUP);
    }
  });

  /** Two of the *same* kind means the directory holds more than one release,
   *  and picking either would be a guess about which. */
  it("refuses when two installers of one kind claim the same platform", () => {
    expect(() =>
      buildManifest({
        tag: "v0.2.0",
        signed: [
          { file: "Veistra_0.2.0_x64-setup.exe", signature: "a" },
          { file: "Veistra_0.1.9_x64-setup.exe", signature: "b" },
        ],
      }),
    ).toThrow(/two nsis installers claim windows-x86_64/);
  });
});
