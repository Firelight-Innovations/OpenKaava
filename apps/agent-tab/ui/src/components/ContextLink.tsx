import { useState } from "react";
import type { ContextLinkProps } from "./types";
import { strings } from "../strings";
import "./composer.css";
/** Issue links are explicit context, without implying a Jira or Linear account is connected. */
export function ContextLink({ onAdd, onCancel }: ContextLinkProps) {
  const [url, setUrl] = useState("");
  const valid = /^https:\/\/[^\s/]+\/.+/i.test(url.trim());
  return (
    <form
      className="at-link-picker"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onAdd(url.trim());
      }}
    >
      <label>
        {strings.issueLink}
        <input
          autoFocus
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://linear.app/…"
        />
      </label>
      <p>{strings.issueLinkHint}</p>
      <button type="button" onClick={onCancel}>
        {strings.cancel}
      </button>
      <button type="submit" disabled={!valid}>
        {strings.addContext}
      </button>
    </form>
  );
}
