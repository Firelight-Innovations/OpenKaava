// @vitest-environment jsdom
/**
 * A page that names an app gets the host box its iframe is portaled into; a
 * page without one keeps the honest "not wired" fallback.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PageInfo } from "../../bindings";
import AppPage from "./AppPage";

afterEach(cleanup);

const costs: PageInfo = {
  id: "costs",
  name: "Cost",
  appId: "costs",
  icon: "receipt",
  mode: "docked",
  key: 5,
  disabled: false,
};
const registry: PageInfo = { ...costs, id: "registry", name: "Registry", appId: null };

describe("AppPage", () => {
  it("mounts the app host, not the fallback, for a page with an app and an instance", () => {
    const onHost = vi.fn();
    const { container } = render(
      <AppPage page={costs} instanceId="costs-page-main" onHost={onHost} />,
    );

    const host = container.querySelector("[data-page-app='costs']");
    expect(host).not.toBeNull();
    expect(onHost).toHaveBeenCalledWith(host);
    expect(screen.queryByText(/not wired/)).toBeNull();
  });

  it("keeps the fallback for a page with no app", () => {
    const { container } = render(<AppPage page={registry} instanceId={null} onHost={vi.fn()} />);

    expect(screen.getByText("Registry is not wired to its app yet.")).not.toBeNull();
    expect(container.querySelector("[data-page-app]")).toBeNull();
  });

  it("keeps the fallback while the instance has not arrived", () => {
    render(<AppPage page={costs} instanceId={undefined} onHost={vi.fn()} />);
    expect(screen.getByText("Cost is not wired to its app yet.")).not.toBeNull();
  });
});
