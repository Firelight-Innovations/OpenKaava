import { describe, expect, it, vi } from "vitest";
import { createSearchClaimer, type SearchIo } from "./search";
import { SEARCH_EVENT } from "./protocol";

function fakeIo() {
  const listeners = new Set<(payload: unknown) => void>();
  const invoke = vi.fn<SearchIo["invoke"]>(() => Promise.resolve(null));
  const io: SearchIo = {
    invoke,
    on: (event, cb) => {
      expect(event).toBe(SEARCH_EVENT);
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const emit = (payload: unknown) => [...listeners].forEach((cb) => cb(payload));
  return { io, invoke, emit, listeners };
}

const base = { placeholder: "Filter files", value: "" };

describe("createSearchClaimer", () => {
  it("sends kaava/search-claim with the placeholder and value", () => {
    const { io, invoke } = fakeIo();
    createSearchClaimer(io)({ ...base, onChange: () => {} });
    expect(invoke).toHaveBeenCalledWith("kaava/search-claim", {
      placeholder: "Filter files",
      value: "",
    });
  });

  it("routes query, submit and escape events to the handlers", () => {
    const { io, emit } = fakeIo();
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const onEscape = vi.fn();
    createSearchClaimer(io)({ ...base, onChange, onSubmit, onEscape });
    emit({ kind: "query", value: "ab" });
    emit({ kind: "submit", value: "ab" });
    emit({ kind: "escape", value: "ab" });
    expect(onChange).toHaveBeenCalledWith("ab");
    expect(onSubmit).toHaveBeenCalledWith("ab");
    expect(onEscape).toHaveBeenCalledWith("ab");
  });

  it("ignores malformed events", () => {
    const { io, emit } = fakeIo();
    const onChange = vi.fn();
    createSearchClaimer(io)({ ...base, onChange });
    emit(null);
    emit({ kind: "other", value: "x" });
    emit("query");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not echo text the shell already holds, but sends an app-driven change", () => {
    const { io, invoke, emit } = fakeIo();
    const handle = createSearchClaimer(io)({ ...base, onChange: () => {} });
    invoke.mockClear();
    emit({ kind: "query", value: "ab" });
    handle.update({ value: "ab" });
    expect(invoke).not.toHaveBeenCalled();
    handle.update({ value: "" });
    expect(invoke).toHaveBeenCalledWith("kaava/search-claim", {
      placeholder: "Filter files",
      value: "",
    });
  });

  it("release sends kaava/search-release once and stops listening", () => {
    const { io, invoke, emit, listeners } = fakeIo();
    const onChange = vi.fn();
    const handle = createSearchClaimer(io)({ ...base, onChange });
    handle.release();
    handle.release();
    expect(invoke.mock.calls.filter(([m]) => m === "kaava/search-release")).toHaveLength(1);
    expect(listeners.size).toBe(0);
    emit({ kind: "query", value: "x" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a second claim replaces the first without releasing the shell's claim", () => {
    const { io, invoke, emit } = fakeIo();
    const claim = createSearchClaimer(io);
    const first = vi.fn();
    const second = vi.fn();
    claim({ ...base, onChange: first });
    claim({ placeholder: "Search nodes", value: "", onChange: second });
    expect(invoke.mock.calls.filter(([m]) => m === "kaava/search-release")).toHaveLength(0);
    emit({ kind: "query", value: "q" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("q");
  });

  it("swallows a refusal from a host with no shell", async () => {
    const { io, invoke } = fakeIo();
    invoke.mockRejectedValue(new Error("no shell"));
    expect(() => createSearchClaimer(io)({ ...base, onChange: () => {} })).not.toThrow();
    await Promise.resolve();
  });
});
