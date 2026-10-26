/**
 * Slash commands in the prompt box: which ones to offer for what has been
 * typed. The agent lists its own; `login` is the tab's, since signing in is a
 * thing the host does beside the agent, not a prompt to it.
 */
import type { AgentCommand, Harness } from "./protocol.generated";
import { builtins, isSkillCommand } from "./commandCatalog";
import { strings } from "./strings";

/** The command the tab answers itself, never sending it to the agent. */
export const LOGIN = "login";

export type CommandSupport = "native" | "agent" | "terminal";
export type OfferedCommand = AgentCommand & { support: CommandSupport };

/** The commands on offer: the agent's, with the tab's own among them. */
export function offered(
  listed: readonly AgentCommand[],
  harness: Harness = "claude",
): OfferedCommand[] {
  const local: AgentCommand[] = [
    { name: LOGIN, description: strings.login.description, hint: null },
    ...Object.entries(strings.localCommands).map(([name, description]) => ({
      name,
      description,
      hint: ({ btw: "question", rename: "name" } as Record<string, string>)[name] ?? null,
    })),
  ];
  const result: OfferedCommand[] = local.map((command) => ({ ...command, support: "native" }));
  for (const command of [
    ...listed.filter((entry) => !isSkillCommand(entry, harness)),
    ...builtins(harness),
  ]) {
    if (result.some((entry) => entry.name === command.name)) continue;
    result.push({
      ...command,
      support: ["new", "reset"].includes(command.name)
        ? "native"
        : listed.some((entry) => entry.name === command.name)
          ? "agent"
          : "terminal",
    });
  }
  return result;
}

/** These commands are children of /skills, not peers of the builtins. */
export function skillCommands(
  listed: readonly AgentCommand[],
  harness: Harness = "claude",
): AgentCommand[] {
  return listed.filter(
    (command, index) =>
      isSkillCommand(command, harness) &&
      listed.findIndex((entry) => entry.name === command.name) === index,
  );
}

/** Route an explicitly submitted command; unadvertised CLI commands never become agent prompts. */
export function commandSupport(
  text: string,
  listed: readonly AgentCommand[],
  harness: Harness = "claude",
): CommandSupport | null {
  const draft = text.trim();
  const candidates = offered(listed, harness).sort((a, b) => b.name.length - a.name.length);
  return (
    candidates.find((command) => {
      const prefix = `/${command.name}`;
      return (
        draft.startsWith(prefix) &&
        (draft.length === prefix.length || /^\s/.test(draft.slice(prefix.length)))
      );
    })?.support ?? null
  );
}

/**
 * The commands that match a draft that is only a slash and a name so far, the
 * name's prefix first and any other containing it after. Nothing once there
 * is a space, since the user is then writing the argument.
 */
export function matching<T extends AgentCommand>(draft: string, commands: readonly T[]): T[] {
  const typed = /^\/(\S*)$/.exec(draft)?.[1].toLowerCase();
  if (typed === undefined) return [];
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(typed));
  const within = commands.filter(
    (c) => !c.name.toLowerCase().startsWith(typed) && c.name.toLowerCase().includes(typed),
  );
  return [...starts, ...within];
}

/** What picking `command` writes into the box: its name, then room for an argument. */
export function completion(command: AgentCommand): string {
  return `/${command.name} `;
}

/** Whether `text` is the tab's own sign-in command, alone on the line. */
export function isLogin(text: string): boolean {
  return text.trim() === `/${LOGIN}`;
}
