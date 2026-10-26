import { describe, expect, it } from "vitest";
import { completion, isLogin, matching, offered } from "./commands";
import type { AgentCommand } from "./protocol.generated";

const cmd = (name: string, hint: string | null = null): AgentCommand => ({
  name,
  description: `${name} it`,
  hint,
});

const AGENT = [cmd("compact", "instructions"), cmd("init"), cmd("review")];

describe("the commands on offer", () => {
  it("add the tab's own login to the agent's, once", () => {
    expect(offered(AGENT).map((c) => c.name)).toEqual(["compact", "init", "review", "login"]);
    expect(offered([...AGENT, cmd("login")]).filter((c) => c.name === "login")).toHaveLength(1);
  });

  it("still offer login before the agent has listed any", () => {
    expect(offered([]).map((c) => c.name)).toEqual(["login"]);
  });
});

describe("matching a draft", () => {
  it("lists everything for a bare slash", () => {
    expect(matching("/", AGENT)).toHaveLength(3);
  });

  it("puts names that start with the text before names that only contain it", () => {
    const all = [cmd("preview"), cmd("review"), cmd("rewind")];
    expect(matching("/re", all).map((c) => c.name)).toEqual(["review", "rewind", "preview"]);
  });

  it("ignores case", () => {
    expect(matching("/COM", AGENT).map((c) => c.name)).toEqual(["compact"]);
  });

  it("offers nothing for ordinary text, or once an argument is being typed", () => {
    expect(matching("fix the bug", AGENT)).toEqual([]);
    expect(matching("", AGENT)).toEqual([]);
    expect(matching("/compact now", AGENT)).toEqual([]);
    expect(matching("look at /init", AGENT)).toEqual([]);
  });

  it("shows no more than a screenful", () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`c${i}`));
    expect(matching("/", many)).toHaveLength(8);
  });
});

describe("picking a command", () => {
  it("writes its name and room for an argument", () => {
    expect(completion(cmd("compact"))).toBe("/compact ");
  });

  it("knows the sign-in command only when it stands alone", () => {
    expect(isLogin("/login")).toBe(true);
    expect(isLogin("  /login \n")).toBe(true);
    expect(isLogin("/login now")).toBe(false);
    expect(isLogin("please /login")).toBe(false);
  });
});
