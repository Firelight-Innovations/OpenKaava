import { describe, expect, it } from "vitest";
import { insertMention, mentionAt, mentionedUris, referenceParts, withChips } from "./mentions";
import type { ContextChip } from "./mentions";

const skill = (command: string): ContextChip => ({
  id: command,
  label: command.replace(/^[$/]/, ""),
  kind: "skill",
  command,
});
const reference: ContextChip = {
  id: "comment-1",
  label: "Comment 1",
  kind: "comment",
  uri: "kaava://canvas/comments/1",
};

describe("skill and project context chips", () => {
  it("preserves Codex dollar invocations without adding a slash", () => {
    expect(withChips("Review this", [skill("$documents:documents")])).toBe(
      "$documents:documents Review this",
    );
    expect(withChips("", [skill("$custom"), skill("$plugin:design")])).toBe(
      "$custom $plugin:design",
    );
  });

  it("writes Claude skill invocations with exactly one slash", () => {
    expect(withChips("Review this", [skill("review"), skill("/team:style")])).toBe(
      "/review /team:style Review this",
    );
  });

  it("retains stable context URIs beside skill invocations and the draft", () => {
    const text = withChips("Check the spacing", [reference, skill("$design")]);
    expect(text).toBe("$design [@Comment 1](<kaava://canvas/comments/1>) Check the spacing");
    expect(mentionedUris(text)).toEqual([reference.uri]);
  });

  it("does not serialize empty commands or undefined chip fields", () => {
    expect(
      withChips("Keep this draft", [skill("   "), { id: "empty", label: "Empty", kind: "skill" }]),
    ).toBe("Keep this draft");
    expect(withChips("", [])).toBe("");
  });

  it("renders inserted project references while leaving ordinary URLs as prose", () => {
    expect(referenceParts("Read [@Comment 1](<kaava://canvas/comments/1>) here")).toEqual([
      { text: "Read " },
      { text: "Comment 1", uri: reference.uri },
      { text: " here" },
    ]);
    expect(referenceParts("See https://example.com")).toEqual([
      { text: "See https://example.com" },
    ]);
    expect(mentionedUris("See kaava://canvas/comments/1")).toEqual([]);
  });
});

describe("caret-local reference completion", () => {
  it("replaces only the active mention and keeps the remaining draft", () => {
    const draft = "Check @comm beside this";
    const query = mentionAt(draft, 11);
    expect(query).toEqual({ start: 6, end: 11, query: "comm" });
    const inserted = insertMention(draft, query!, {
      title: "Comment 1",
      uri: reference.uri!,
      kind: "comment",
    });
    expect(inserted.text).toBe("Check [@Comment 1](<kaava://canvas/comments/1>)  beside this");
    expect(inserted.text.slice(inserted.caret)).toBe(" beside this");
  });

  it("ignores email addresses and mentions outside the caret token", () => {
    expect(mentionAt("someone@example.com", 19)).toBeNull();
    expect(mentionAt("@comment then text", 18)).toBeNull();
  });
});
