// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GoogleAuthStatus } from "../../bindings";

const googleAuthStatus = vi.fn<() => Promise<GoogleAuthStatus>>();
const googleSignIn = vi.fn<() => Promise<string>>();
const googleSignOut = vi.fn<() => Promise<void>>();
const googleCancelSignIn = vi.fn<() => Promise<void>>();
const setGoogleClientSecret = vi.fn<(secret: string) => Promise<void>>();

vi.mock("../../bindings", () => ({
  googleAuthStatus: () => googleAuthStatus(),
  googleSignIn: () => googleSignIn(),
  googleSignOut: () => googleSignOut(),
  googleCancelSignIn: () => googleCancelSignIn(),
  setGoogleClientSecret: (secret: string) => setGoogleClientSecret(secret),
  onSettingsChanged: () => Promise.resolve(() => undefined),
}));

const { default: CloudAccountPanel } = await import("./CloudAccountPanel");

function status(over: Partial<GoogleAuthStatus>): GoogleAuthStatus {
  return {
    configured: true,
    hasClientId: true,
    hasClientSecret: true,
    email: null,
    pending: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  googleSignIn.mockResolvedValue("b@example.com");
  googleSignOut.mockResolvedValue(undefined);
  googleCancelSignIn.mockResolvedValue(undefined);
  setGoogleClientSecret.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("CloudAccountPanel", () => {
  it("cannot sign in until both halves of the client are set", async () => {
    googleAuthStatus.mockResolvedValue(status({ configured: false, hasClientSecret: false }));
    render(<CloudAccountPanel />);
    const button = await screen.findByRole("button", { name: "Sign in with Google" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Set the client ID below/)).toBeTruthy();
  });

  it("signs in and then shows the account", async () => {
    googleAuthStatus.mockResolvedValueOnce(status({}));
    googleAuthStatus.mockResolvedValue(status({ email: "b@example.com" }));
    render(<CloudAccountPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    expect(googleSignIn).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Signed in as b@example.com/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("offers Cancel while the browser is out", async () => {
    googleAuthStatus.mockResolvedValue(status({ pending: true }));
    render(<CloudAccountPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(googleCancelSignIn).toHaveBeenCalledOnce();
  });

  it("shows a failed sign-in as an alert", async () => {
    googleAuthStatus.mockResolvedValue(status({}));
    googleSignIn.mockRejectedValue("Google sign-in was refused (access_denied)");
    render(<CloudAccountPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    expect((await screen.findByRole("alert")).textContent).toContain("access_denied");
  });

  it("sends the secret once and clears the field, never reading it back", async () => {
    googleAuthStatus.mockResolvedValue(status({ hasClientSecret: false, configured: false }));
    render(<CloudAccountPanel />);
    const field = (await screen.findByLabelText("Google OAuth client secret")) as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "  GOCSPX-abc  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(setGoogleClientSecret).toHaveBeenCalledWith("GOCSPX-abc");
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("signs out", async () => {
    googleAuthStatus.mockResolvedValue(status({ email: "b@example.com" }));
    render(<CloudAccountPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(googleSignOut).toHaveBeenCalledOnce();
  });
});
