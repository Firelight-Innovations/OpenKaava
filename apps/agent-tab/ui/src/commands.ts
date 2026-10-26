/**
 * Slash commands in the prompt box: which ones to offer for what has been
 * typed. The agent lists its own; `login` is the tab's, since signing in is a
 * thing the host does beside the agent, not a prompt to it.
 */
import type { AgentCommand } from "./protocol.generated";
import { strings } from "./strings";

/** The command the tab answers itself, never sending it to the agent. */
export const LOGIN = "login";

/** The most commands the menu lists at once. */
const SHOWN = 8;

/** The commands on offer: the agent's, with the tab's own among them. */
export function offered(listed: readonly AgentCommand[]): AgentCommand[] {
  if (listed.some((c) => c.name === LOGIN)) return [...listed];
  return [...listed, { name: LOGIN, description: strings.login.description, hint: null }];
}

/**
 * The commands that match a draft that is only a slash and a name so far, the
 * name's prefix first and any other containing it after. Nothing once there
 * is a space, since the user is then writing the argument.
 */
export function matching(draft: string, commands: readonly AgentCommand[]): AgentCommand[] {
  const typed = /^\/(\S*)$/.exec(draft)?.[1].toLowerCase();
  if (typed === undefined) return [];
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(typed));
  const within = commands.filter(
    (c) => !c.name.toLowerCase().startsWith(typed) && c.name.toLowerCase().includes(typed),
  );
  return [...starts, ...within].slice(0, SHOWN);
}

/** What picking `command` writes into the box: its name, then room for an argument. */
export function completion(command: AgentCommand): string {
  return `/${command.name} `;
}

/** Whether `text` is the tab's own sign-in command, alone on the line. */
export function isLogin(text: string): boolean {
  return text.trim() === `/${LOGIN}`;
}
