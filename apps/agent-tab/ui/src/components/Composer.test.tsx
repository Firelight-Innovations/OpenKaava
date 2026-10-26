// @vitest-environment jsdom
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "./Composer";

afterEach(cleanup);

function box(extra: Partial<Parameters<typeof Composer>[0]> = {}) {
  return render(
    <Composer
      ref={createRef()}
      value=""
      placeholder="Ask"
      onChange={() => {}}
      onKeyDown={() => {}}
      notices={null}
      menu={null}
      menuActiveId={null}
      controls={null}
      meters={null}
      action={null}
      {...extra}
    />,
  );
}

describe("Composer pasted pictures", () => {
  it("hands a pasted image to the tab and keeps pasted text as text", () => {
    const onPasteImages = vi.fn();
    box({ onPasteImages });
    const input = screen.getByRole("textbox");
    const file = new File(["x"], "a.png", { type: "image/png" });
    const item = { kind: "file", type: "image/png", getAsFile: () => file };
    fireEvent.paste(input, { clipboardData: { items: [item] } });
    expect(onPasteImages).toHaveBeenCalledWith([file]);

    onPasteImages.mockClear();
    fireEvent.paste(input, {
      clipboardData: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] },
    });
    expect(onPasteImages).not.toHaveBeenCalled();
  });

  it("shows a thumbnail that opens full size and closes, and one that can be removed", () => {
    const onRemoveImage = vi.fn();
    box({ images: [{ id: "i1", mime: "image/png", data: "AAAA" }], onRemoveImage });
    fireEvent.click(screen.getByRole("button", { name: "View image" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove image" }));
    expect(onRemoveImage).toHaveBeenCalledWith("i1");
  });

  it("marks up a picture and saves the annotated one in its place", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,QkJC",
    );
    const onReplaceImage = vi.fn();
    box({ images: [{ id: "i1", mime: "image/jpeg", data: "AAAA" }], onReplaceImage });
    fireEvent.click(screen.getByRole("button", { name: "View image" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark up image" }));
    expect(screen.getByRole("toolbar")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rectangle" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onReplaceImage).toHaveBeenCalledWith("i1", { mime: "image/png", data: "QkJC" });
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});
