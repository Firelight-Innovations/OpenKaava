// @vitest-environment jsdom
/**
 * Where keyboard focus goes as the settings screen opens and shuts. Ctrl+, opens
 * it from fields, terminals and app frames, and focus left behind there would
 * send typing to the hidden surface and keep Escape from closing the screen.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import SettingsScreen from "./SettingsScreen";
import { CLAIMED_FIELD_CLASS } from "../titlebarSearch";
import type { SettingsSession } from "./useSettings";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/** A ready session with no sections: nothing here reads a setting. */
const session: SettingsSession = {
  groups: [],
  valueOf: () => false,
  isChanged: () => false,
  changedIn: () => 0,
  set: () => {},
  reset: () => {},
  resetGroup: () => {},
  error: null,
  ready: true,
};

/** A field outside the screen, focused, as a terminal or editor would be. */
function focusedField(): HTMLInputElement {
  const field = document.createElement("input");
  document.body.append(field);
  field.focus();
  return field;
}

describe("SettingsScreen focus", () => {
  it("takes focus from the field that had it", () => {
    const field = focusedField();
    render(<SettingsScreen session={session} landOn={null} />);

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement).not.toBe(field);
  });

  it("gives focus back when it closes", () => {
    const field = focusedField();
    const { unmount } = render(<SettingsScreen session={session} landOn={null} />);

    unmount();
    expect(document.activeElement).toBe(field);
  });

  it("leaves focus where a click on the way out put it", () => {
    focusedField();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    const { unmount } = render(<SettingsScreen session={session} landOn={null} />);

    elsewhere.focus();
    unmount();
    expect(document.activeElement).toBe(elsewhere);
  });

  // The screen's filter is typed in the title bar's claimed field, outside the
  // dialog; closing from there is not focus going somewhere else.
  it("gives focus back when it closes from its title-bar filter", () => {
    const field = focusedField();
    const slot = document.createElement("label");
    slot.className = CLAIMED_FIELD_CLASS;
    const filter = document.createElement("input");
    slot.append(filter);
    document.body.append(slot);
    const { unmount } = render(<SettingsScreen session={session} landOn={null} />);

    filter.focus();
    unmount();
    expect(document.activeElement).toBe(field);
  });
});
