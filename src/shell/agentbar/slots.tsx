/**
 * The agent bar's slot map, the same pattern as the agent tab's
 * (`apps/agent-tab/ui/src/components/registry.tsx`). The shell may not import
 * an app's source, so the bar keeps its own map; both read the `--k-*` tokens
 * in `src/agent-tokens.css`, so a restyle there reaches both.
 */
import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";
import {
  BarFrame,
  BarHarness,
  BarInput,
  BarNotice,
  BarSend,
  type BarFrameProps,
  type BarHarnessProps,
  type BarInputProps,
  type BarNoticeProps,
  type BarSendProps,
} from "./parts";

export interface BarSlots {
  Frame: ComponentType<BarFrameProps>;
  Notice: ComponentType<BarNoticeProps>;
  /** The harness label today; a picker once there is more than one harness. */
  Harness: ComponentType<BarHarnessProps>;
  Input: ComponentType<BarInputProps>;
  Send: ComponentType<BarSendProps>;
}

/** The one mapping. Change a line here to swap that piece of the bar. */
export const defaultBarSlots: BarSlots = {
  Frame: BarFrame,
  Notice: BarNotice,
  Harness: BarHarness,
  Input: BarInput,
  Send: BarSend,
};

const BarSlotsContext = createContext<BarSlots>(defaultBarSlots);

export function useBarSlots(): BarSlots {
  return useContext(BarSlotsContext);
}

/** Overrides some of the bar's slots for everything inside it. */
export function BarSlotsProvider({
  slots,
  children,
}: {
  slots: Partial<BarSlots>;
  children: ReactNode;
}) {
  const outer = useBarSlots();
  const merged = useMemo(() => ({ ...outer, ...slots }), [outer, slots]);
  return <BarSlotsContext.Provider value={merged}>{children}</BarSlotsContext.Provider>;
}
