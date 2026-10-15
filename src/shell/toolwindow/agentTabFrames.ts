/**
 * Where one of an agent tab's events goes (`apps::agent_tab`): the app frame
 * whose instance the payload names, once it has said hello, at the origin it
 * said it from. Every other frame, an agent tab for another session included,
 * gets nothing.
 */
export function agentTabFrames<W>(
  frames: Iterable<[W, { id: string; isApp: boolean; origin: string | null }]>,
  payload: unknown,
): [W, string][] {
  const instanceId = (payload as { instanceId?: unknown } | null)?.instanceId;
  const found: [W, string][] = [];
  for (const [win, frame] of frames) {
    if (frame.isApp && frame.origin !== null && frame.id === instanceId) {
      found.push([win, frame.origin]);
    }
  }
  return found;
}
