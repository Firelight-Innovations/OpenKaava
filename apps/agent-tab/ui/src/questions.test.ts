// @vitest-environment jsdom
/** The logic behind a question card, without drawing one. */
import { describe, expect, it } from "vitest";
import type { Question } from "./protocol.generated";
import {
  answerOpenCard,
  complete,
  current,
  emptyReplies,
  numberKey,
  oneClick,
  openCard,
  pick,
  registerOpen,
  typeOther,
  type OpenCard,
} from "./questions";

const choice = (value: string) => ({ value, label: value, description: null });

const single: Question = {
  id: "a",
  header: null,
  text: "Single?",
  choices: [choice("x"), choice("y")],
  multi: false,
  other: true,
};

const multi: Question = {
  id: "b",
  header: null,
  text: "Multi?",
  choices: [choice("p"), choice("q"), choice("r")],
  multi: true,
  other: false,
};

describe("replies to a question", () => {
  it("replace the pick and the typed text on a single-select", () => {
    let replies = typeOther([single], emptyReplies([single]), 0, "mine")!;
    expect(replies).toEqual([{ picks: [], other: "mine" }]);
    replies = pick([single], replies, 0, "y");
    expect(replies).toEqual([{ picks: ["y"], other: null }]);
    replies = pick([single], replies, 0, "x");
    expect(replies).toEqual([{ picks: ["x"], other: null }]);
  });

  it("toggle on a multi-select, in the agent's order", () => {
    let replies = emptyReplies([multi]);
    replies = pick([multi], replies, 0, "r");
    replies = pick([multi], replies, 0, "p");
    expect(replies[0].picks).toEqual(["p", "r"]);
    replies = pick([multi], replies, 0, "r");
    expect(replies[0].picks).toEqual(["p"]);
  });

  it("ignore a value the agent did not offer", () => {
    expect(pick([single], emptyReplies([single]), 0, "z")).toEqual([{ picks: [], other: null }]);
  });

  it("refuse typed text where the question takes none", () => {
    expect(typeOther([multi], emptyReplies([multi]), 0, "text")).toBeNull();
  });

  it("are complete when every question says something", () => {
    const qs = [single, multi];
    let replies = emptyReplies(qs);
    expect(complete(qs, replies)).toBe(false);
    expect(current(qs, replies)).toBe(0);
    replies = typeOther(qs, replies, 0, "  ")!;
    expect(complete(qs, replies)).toBe(false);
    replies = pick(qs, replies, 0, "x");
    expect(current(qs, replies)).toBe(1);
    replies = pick(qs, replies, 1, "q");
    expect(complete(qs, replies)).toBe(true);
    // All answered: the keys stay on the last question.
    expect(current(qs, replies)).toBe(1);
    expect(complete([], [])).toBe(true);
  });

  it("send on one click only for a single question with one pick", () => {
    expect(oneClick([single])).toBe(true);
    expect(oneClick([multi])).toBe(false);
    expect(oneClick([single, single])).toBe(false);
    expect(oneClick([])).toBe(false);
  });
});

describe("the open card", () => {
  const card = (takes: boolean): OpenCard & { got: string[] } => {
    const got: string[] = [];
    return {
      got,
      pickNumber: () => true,
      answerText: (text) => {
        got.push(text);
        return takes;
      },
    };
  };

  it("is the newest one registered, and none once they all close", () => {
    const a = card(true);
    const b = card(true);
    const offA = registerOpen(a);
    const offB = registerOpen(b);
    expect(openCard()).toBe(b);
    expect(answerOpenCard(" typed ")).toBe(true);
    expect(b.got).toEqual(["typed"]);
    offB();
    expect(openCard()).toBe(a);
    offA();
    expect(openCard()).toBeNull();
    expect(answerOpenCard("typed")).toBe(false);
  });

  it("lets blank text and a card that takes none fall through to the agent", () => {
    const off = registerOpen(card(false));
    expect(answerOpenCard("   ")).toBe(false);
    expect(answerOpenCard("text")).toBe(false);
    off();
  });
});

describe("a number key", () => {
  const press = (init: KeyboardEventInit, target?: HTMLElement) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, ...init });
    if (target) Object.defineProperty(event, "target", { value: target });
    return numberKey(event);
  };

  it("picks 1 to 9", () => {
    expect(press({ key: "1" })).toBe(0);
    expect(press({ key: "9" })).toBe(8);
    expect(press({ key: "0" })).toBeNull();
    expect(press({ key: "a" })).toBeNull();
  });

  it("is typing, not a pick, with a modifier, held, or in a field with text", () => {
    expect(press({ key: "1", ctrlKey: true })).toBeNull();
    expect(press({ key: "1", altKey: true })).toBeNull();
    expect(press({ key: "1", repeat: true })).toBeNull();
    const field = document.createElement("textarea");
    expect(press({ key: "1" }, field)).toBe(0);
    field.value = "step ";
    expect(press({ key: "1" }, field)).toBeNull();
  });
});
