// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ObjectPanel from "./ObjectPanel";
import type { TypeDef } from "./objects";

afterEach(cleanup);

const vehicle: TypeDef = {
  id: "vehicle",
  name: "Vehicle",
  color: "#0a0",
  icon: "box",
  builtin: false,
  fields: [
    { key: "wheels", label: "Wheels", kind: "number" },
    { key: "driver", label: "Driver", kind: "text" },
    { key: "notes", label: "Notes", kind: "multiline" },
    { key: "class", label: "Class", kind: "enum", options: ["car", "bike"] },
    { key: "armed", label: "Armed", kind: "bool" },
    { key: "refs", label: "Refs", kind: "path-list" },
  ],
};

function panel(props: Partial<React.ComponentProps<typeof ObjectPanel>> = {}) {
  const onProp = vi.fn();
  render(
    <ObjectPanel
      frame={{ id: "f", name: "Buggy", object: { type: "vehicle", props: {} }, child: null }}
      types={[vehicle]}
      readOnly={false}
      refs={[]}
      focusName={false}
      canvases={[]}
      current="world"
      onName={vi.fn()}
      onType={vi.fn()}
      onProp={onProp}
      onOpenChild={vi.fn()}
      onUnlink={vi.fn()}
      onCreateChild={vi.fn()}
      onLinkExisting={vi.fn()}
      onManageTypes={vi.fn()}
      putCard={vi.fn()}
      onSendError={vi.fn()}
      sendSlot={null}
      {...props}
    />,
  );
  return onProp;
}

describe("ObjectPanel", () => {
  it("draws one control per field of a custom type, by kind", () => {
    panel();
    expect(screen.getByLabelText("Wheels").tagName).toBe("INPUT");
    expect(screen.getByLabelText("Driver").tagName).toBe("INPUT");
    expect(screen.getByLabelText("Notes").tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("Class").tagName).toBe("SELECT");
    expect((screen.getByLabelText("Armed") as HTMLInputElement).type).toBe("checkbox");
    expect(screen.getByLabelText("Refs").tagName).toBe("TEXTAREA");
  });

  it("commits a number on blur and a choice at once", () => {
    const onProp = panel();
    const wheels = screen.getByLabelText("Wheels");
    fireEvent.change(wheels, { target: { value: "4" } });
    fireEvent.blur(wheels);
    expect(onProp).toHaveBeenCalledWith("wheels", 4);
    fireEvent.change(screen.getByLabelText("Class"), { target: { value: "bike" } });
    expect(onProp).toHaveBeenCalledWith("class", "bike");
  });

  it("disables every field when read-only", () => {
    panel({ readOnly: true });
    expect((screen.getByLabelText("Wheels") as HTMLInputElement).disabled).toBe(true);
  });
});
