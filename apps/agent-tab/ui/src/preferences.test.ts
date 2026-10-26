import { describe, expect, it } from "vitest";
import { featuredModels, newestModels, effortIndex } from "./preferences";
import { insertMention, mentionedUris, mentionAt } from "./mentions";
import { friendlyError, cleanError } from "./errors";

describe("the compact model list", () => {
  const models = [
    "Default",
    "Opus 4.6",
    "Sonnet 5.5",
    "Opus 5.5",
    "Fable 5.1",
    "Haiku 5.5",
    "Sonnet 5",
  ].map((name, i) => ({ value: i ? name : "default", name }));
  it("offers the latest of each family and retains an older selected model", () => {
    expect(featuredModels(models, null).map((m) => m.name)).toEqual([
      "Sonnet 5.5",
      "Opus 5.5",
      "Haiku 5.5",
      "Fable 5.1",
    ]);
    expect(featuredModels(models, "Opus 4.6").map((m) => m.name)).toContain("Opus 4.6");
    expect(
      newestModels([
        { value: "a", name: "GPT 6.9" },
        { value: "b", name: "GPT 6.10" },
      ])[0].value,
    ).toBe("b");
  });
  it("uses the top animation for both Max and Ultra without changing their wire values", () => {
    expect(effortIndex("ultra")).toBe(4);
    expect(effortIndex("max")).toBe(4);
  });
});

describe("project mentions", () => {
  it("searches at the caret, ignores emails, and leaves following prose intact", () => {
    expect(mentionAt("hello@example.com", 17)).toBeNull();
    const text = "Look @read and keep this";
    const query = mentionAt(text, 10)!;
    expect(query.query).toBe("read");
    const next = insertMention(text, query, {
      uri: "veistra://file/README.md",
      title: "README.md",
      kind: "file",
    });
    expect(next.text).toBe("Look [@README.md](<veistra://file/README.md>)  and keep this");
    expect(mentionedUris(next.text)).toEqual(["veistra://file/README.md"]);
  });
  it("preserves stable canvas and comment URIs", () => {
    const next = insertMention("@login", mentionAt("@login", 6)!, {
      uri: "veistra://canvas/design#frame=login",
      title: "Login design",
      kind: "frame",
    });
    expect(mentionedUris(next.text)).toEqual(["veistra://canvas/design#frame=login"]);
  });
});

describe("friendly failures", () => {
  it("retains reset details while removing transport wrappers", () => {
    const notice = friendlyError(
      "Error: Internal error: You've hit your session limit · resets 11:50pm (America/Chicago)",
    );
    expect(notice.limited).toBe(true);
    expect(notice.detail).toContain("11:50pm (America/Chicago)");
    expect(notice.detail).not.toContain("Internal error");
    expect(cleanError("Error: Internal error: unavailable")).toBe("unavailable");
  });
});
