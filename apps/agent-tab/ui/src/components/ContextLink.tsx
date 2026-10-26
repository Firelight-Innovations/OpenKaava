import { useState } from "react";
import { Link } from "lucide-react";
import type { ContextLinkProps } from "./types";
import { strings } from "../strings";
import "./composer.css";
/** Issue links are explicit context, without implying a Jira or Linear account is connected. */
export function ContextLink({ provider = "", onAdd, onCancel }: ContextLinkProps) {
  const [url, setUrl] = useState("");
  const valid = /^https:\/\/[^\s/]+\/.+/i.test(url.trim());
  return (
    <form
      className="at-link-picker"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onAdd(url.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <label className="at-link-picker__field">
        <span className="at-link-picker__title">
          <Link size={13} aria-hidden="true" />
          {strings.issues.title(provider)}
        </span>
        <input
          autoFocus
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={strings.issues.placeholder[provider] ?? "https://…"}
        />
      </label>
      <p>{strings.issueLinkHint}</p>
      <div className="at-link-picker__actions">
        <button type="button" onClick={onCancel}>
          {strings.cancel}
        </button>
        <button type="submit" className="at-link-picker__primary" disabled={!valid}>
          {strings.addContext}
        </button>
      </div>
    </form>
  );
}
