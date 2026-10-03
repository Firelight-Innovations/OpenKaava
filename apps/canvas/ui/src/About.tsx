/**
 * Credits for the drawing editor. Excalidraw's own branding is taken out of the
 * canvas (its menu links, welcome screen and library site), and this is where
 * the attribution its MIT licence asks for lives instead.
 *
 * Rejected: leaving Excalidraw's menu in place for the sake of the credit. Its
 * items link to excalidraw.com and its socials, which read as a second product
 * inside this one; a plain credits entry keeps the notice without the detour.
 */
import { useEffect } from "react";

export default function About({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="cv__about-scrim" onClick={onClose}>
      <div
        className="cv__about"
        role="dialog"
        aria-modal="true"
        aria-label="About this editor"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>About this editor</h2>
        <p>
          The drawing editor is <strong>Excalidraw</strong>, used under the MIT License. Copyright
          (c) 2020 Excalidraw.
        </p>
        <p>
          The fonts it bundles, including Nunito and Excalifont, are under the SIL Open Font
          License.
        </p>
        <p className="cv__hint">
          Diagrams, comments and reference images are this app&apos;s own, stored beside the canvas
          file in the repository.
        </p>
        <button
          type="button"
          className="k-btn k-btn--secondary k-btn--sm"
          onClick={onClose}
          autoFocus
        >
          Close
        </button>
      </div>
    </div>
  );
}
