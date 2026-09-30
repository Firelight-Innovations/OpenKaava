/**
 * Harness page for `<SceneView>`: the committed fixture, a selection readout,
 * a capture button, and a stand-in for the markup layer that exercises the
 * `SceneViewHandle` contract. Click "Freeze and pin", then click the scene: a
 * marker is placed where the ray hits and follows that point when the camera
 * moves. Not shipped.
 */
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../src/tokens.css";
import roomUrl from "../fixtures/room.glb?url";
import { SceneView } from "../src";
import type { PickHit, SceneViewHandle, ViewportPoint } from "../src";

function PinLayer({ view, armed }: { view: SceneViewHandle; armed: boolean }) {
  const [pin, setPin] = useState<PickHit | null>(null);
  const [at, setAt] = useState<ViewportPoint | null>(null);

  useEffect(() => {
    if (!pin) return;
    const update = () => setAt(view.project(pin.worldPoint));
    update();
    return view.onCameraChange(update);
  }, [pin, view]);

  return (
    <>
      <div
        style={{ position: "absolute", inset: 0, pointerEvents: armed ? "auto" : "none" }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setPin(view.pick(e.clientX - rect.left, e.clientY - rect.top));
        }}
      />
      {pin && at?.visible && (
        <div
          title={pin.nodePath}
          style={{
            position: "absolute",
            left: at.x - 8,
            top: at.y - 8,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "var(--danger)",
            pointerEvents: "none",
          }}
        />
      )}
    </>
  );
}

function Harness() {
  const view = useRef<SceneViewHandle | null>(null);
  const [handle, setHandle] = useState<SceneViewHandle | null>(null);
  const [armed, setArmed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [png, setPng] = useState<string | null>(null);

  useEffect(() => setHandle(view.current), []);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 320px",
        height: "100vh",
        gap: 8,
        padding: 8,
        background: "var(--bg-canvas)",
        color: "var(--txt-secondary)",
        boxSizing: "border-box",
      }}
    >
      <SceneView ref={view} source={roomUrl} selectedPath={selected} onSelect={setSelected}>
        {handle && <PinLayer view={handle} armed={armed} />}
      </SceneView>
      <div style={{ overflow: "auto", font: "12px Inter, sans-serif" }}>
        <button
          type="button"
          onClick={() => {
            const next = !armed;
            setArmed(next);
            view.current?.setInteractive(!next);
          }}
        >
          {armed ? "Unfreeze" : "Freeze and pin"}
        </button>{" "}
        <button
          type="button"
          onClick={async () => {
            const blob = await view.current!.capture({ scale: 1 });
            setPng(URL.createObjectURL(blob));
          }}
        >
          Capture
        </button>
        <p>Selected: {selected ?? "none"}</p>
        {png && <img src={png} alt="Captured 3D frame" style={{ width: "100%" }} />}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
