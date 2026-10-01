/**
 * The GitHub view: what is open on the repository this cluster is a checkout
 * of, and a way to start work on any of it.
 *
 * Row layout and interaction adapted from `stablyai/orca`'s Tasks page
 * (`src/renderer/src/components/TaskPage.tsx` and its work-item row) —
 * MIT-licensed, © Stably AI. One list holding both kinds, a kind glyph tinted
 * by state, the number and title on one line, and the item's own metadata
 * under it. Orca's row also carries checks, review state and an assignee stack;
 * those need a request per row and this release does not make them.
 *
 * **Every empty list here says why it is empty.** That is the one rule the whole
 * component is arranged around: a panel that draws nothing teaches the person
 * that GitHub is broken, and four of the six states below exist only so that
 * never happens. Reaching both kinds and every state without typing is [`Axes`].
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IssueDot, PullRequest } from "../../ui/Icon";
import { useTitlebarSearch } from "../titlebarSearch";
import type {
  GithubAuthControl,
  GithubControl,
  GithubItem,
  GithubTrouble,
  WorktreeControl,
} from "../contract";
import { GITHUB_STATE_LABEL, GITHUB_STATE_TOKEN } from "../contract";
import type { ParsedQuery, QueryScope, QueryState } from "./query";
import {
  applyQuery,
  describeQuery,
  fetchScopeOf,
  narrowsByText,
  parseQuery,
  withScope,
  withState,
} from "./query";
import { useGithubFeed } from "./useGithubFeed";
import "./github.css";

/** The kind axis, in the order GitHub's own tabs use. */
const KIND_CHOICES: { value: QueryScope; label: string }[] = [
  { value: "all", label: "All" },
  { value: "issue", label: "Issues" },
  { value: "pull", label: "Pull requests" },
];

/**
 * The state axis.
 *
 * `Any` rather than a second `All`, which would put the same word in both rows
 * for two different meanings. `Merged` is here because it is the state a person
 * reviewing pull requests actually looks for, and because the query language
 * already had it with nothing on screen to reach it — pressing it narrows to
 * pull requests on its own, which is `parseQuery`'s rule and not a special case
 * of this row.
 *
 * `Draft` is deliberately absent. It is reachable by typing `is:draft`, it is a
 * kind of open rather than a fourth state, and a fifth button would wrap this
 * row on a panel that is 380px wide by default.
 */
const STATE_CHOICES: { value: QueryState; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "merged", label: "Merged" },
  { value: "all", label: "Any" },
];

export interface GithubPanelProps {
  /** `null` for "no cluster is active" — nothing is fetched, matching every
   *  other region's rule for an unset cluster. */
  clusterId: string | null;
  /** Whether this view is the one on screen. The panel stays mounted when it is
   *  not — see `rail/GitPage.tsx` — and must not spend GitHub requests while
   *  hidden, which at sixty an hour signed out is a real budget. */
  active: boolean;
  githubControl: GithubControl;
  authControl: GithubAuthControl;
  /**
   * The existing worktree path, passed in rather than imported.
   *
   * This is the whole of "open an item": `create(clusterId, suggestedBranch)`,
   * where the name came off the item. There is no GitHub-specific worktree code
   * anywhere in this feature, and taking the interface as a prop is what makes
   * that visible at the call site instead of buried in a helper.
   */
  worktreeControl: WorktreeControl;
  /** Called after a worktree is made, so the shell can refetch what changed.
   *  The panel does not know what else moved and deliberately does not try. */
  onWorktreeCreated?: () => void;
}

export default function GithubPanel({
  clusterId,
  active,
  githubControl,
  authControl,
  worktreeControl,
  onWorktreeCreated,
}: GithubPanelProps) {
  const [filter, setFilter] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  // The filter is typed in the title bar's search field, claimed while the user
  // is working in this panel and given back when they click elsewhere. See
  // `docs/design-notes/titlebar-search.md`.
  const holding = usePanelHoldsFocus(panelRef);

  // Parsed once per keystroke and used twice — for the fetch scope and for the
  // predicate — so that the request and the list can never disagree about what
  // was asked for.
  const query = useMemo(() => parseQuery(filter), [filter]);
  const scope = fetchScopeOf(query);

  const { feed, loading, refresh } = useGithubFeed(githubControl, clusterId, scope, active);

  /** The item currently being opened, so its row can say so. `null` when idle;
   *  one at a time, because two worktrees from two clicks is never the intent. */
  const [opening, setOpening] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const open = useCallback(
    (item: GithubItem) => {
      if (clusterId === null || opening !== null) return;
      setOpening(item.id);
      setFailure(null);
      void worktreeControl
        .create(clusterId, item.suggestedBranch)
        .then(() => {
          setOpening(null);
          onWorktreeCreated?.();
        })
        .catch((err: unknown) => {
          setOpening(null);
          // Shown verbatim. `git.rs` writes these to be read by whoever caused
          // them — "`issue-42-…` already exists — pick another name" is the
          // common one, and rewording it here would lose the name it quotes.
          setFailure(String(err));
        });
    },
    [clusterId, opening, worktreeControl, onWorktreeCreated],
  );

  // Failures are swallowed on purpose. Rust refuses a non-GitHub address and
  // the browser may simply not open; neither is worth taking over the panel for
  // when the row is still there to click again.
  const openInBrowser = useCallback(
    (url: string) => void githubControl.openInBrowser(url).catch(() => {}),
    [githubControl],
  );

  const visible = useMemo(
    () => (feed?.state === "ready" ? applyQuery(feed.items, query) : []),
    [feed, query],
  );

  useTitlebarSearch(
    holding && feed?.state === "ready"
      ? { placeholder: FILTER_PLACEHOLDER, value: filter, onChange: setFilter }
      : null,
  );

  if (clusterId === null) {
    return <Empty title="No cluster is open." />;
  }

  return (
    <div className="github" ref={panelRef}>
      <Head
        repo={feed?.state === "ready" ? feed.repo : null}
        loading={loading}
        onRefresh={refresh}
      />

      {feed?.state === "ready" && (
        <>
          <Axes query={query} filter={filter} onFilter={setFilter} />
        </>
      )}

      {failure && (
        <p className="github__failure" role="alert">
          {failure}
        </p>
      )}

      <Body
        feed={feed}
        loading={loading}
        visible={visible}
        query={query}
        opening={opening}
        onOpen={open}
        onOpenInBrowser={openInBrowser}
        onSignIn={authControl.signIn}
        onSignedIn={refresh}
      />
    </div>
  );
}

const FILTER_PLACEHOLDER = "is:draft  label:bug  author:me";

/**
 * Whether the user's last interaction was inside the panel.
 *
 * Set by focus or a press in the panel and cleared by a press anywhere else in
 * the document, or by focus leaving the window for an app frame. A press on the
 * title bar's search field does not clear it: that field is where the filter is
 * being typed, and clearing it would take the field away mid-word.
 */
function usePanelHoldsFocus(panel: React.RefObject<HTMLElement | null>): boolean {
  const [holding, setHolding] = useState(false);
  useEffect(() => {
    // On the document rather than the panel: the panel's element does not exist
    // while it shows its "no cluster" state, and these must follow it in.
    const press = (event: Event) => {
      const target = event.target as Element | null;
      if (target && panel.current?.contains(target)) setHolding(true);
      else if (target && !target.closest?.(".search-slot")) setHolding(false);
    };
    const left = () => setHolding(false);
    document.addEventListener("focusin", press);
    document.addEventListener("pointerdown", press, true);
    window.addEventListener("blur", left);
    return () => {
      document.removeEventListener("focusin", press);
      document.removeEventListener("pointerdown", press, true);
      window.removeEventListener("blur", left);
    };
  }, [panel]);
  return holding;
}

function Head({
  repo,
  loading,
  onRefresh,
}: {
  repo: string | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="github__head">
      <span className="github__repo" title={repo ?? undefined}>
        {repo ?? "GitHub"}
      </span>
      <button
        type="button"
        className="github__refresh"
        onClick={onRefresh}
        disabled={loading}
        aria-label="Refresh"
      >
        {loading ? "Loading…" : "Refresh"}
      </button>
    </div>
  );
}

/**
 * Kind and state, as two rows of buttons over the box they write into.
 *
 * The list has always held pull requests and the filter language has always had
 * `is:pr` and `is:closed`; what was missing was anything on screen saying so,
 * which made a panel that could already do it read as an issues-only one.
 *
 * These buttons hold no state. The highlight is read out of the parsed query,
 * so typing `is:pr` lights the same button pressing it would have, and pressing
 * one edits the text rather than shadowing it — see the note in `query.ts` on
 * why the box stays the only source of truth.
 */
function Axes({
  query,
  filter,
  onFilter,
}: {
  query: ParsedQuery;
  filter: string;
  onFilter: (next: string) => void;
}) {
  return (
    <div className="github__axes">
      <div className="github__axis" role="group" aria-label="Kind">
        {KIND_CHOICES.map(({ value, label }) => (
          <Chip
            key={value}
            label={label}
            on={query.scope === value}
            onPress={() => onFilter(withScope(filter, value))}
          />
        ))}
      </div>
      <div className="github__axis" role="group" aria-label="State">
        {STATE_CHOICES.map(({ value, label }) => (
          <Chip
            key={value}
            label={label}
            on={query.state === value}
            onPress={() => onFilter(withState(filter, value))}
          />
        ))}
      </div>
    </div>
  );
}

/** `aria-pressed` rather than a tab or a radio: these are two independent
 *  narrowings of one list, not a choice of what the panel is showing. */
function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <button
      type="button"
      className={`github__chip${on ? " github__chip--on" : ""}`}
      aria-pressed={on}
      onClick={onPress}
    >
      {label}
    </button>
  );
}

/** Everything below the filter box: one of six states, and exactly one. */
function Body({
  feed,
  loading,
  visible,
  query,
  opening,
  onOpen,
  onOpenInBrowser,
  onSignIn,
  onSignedIn,
}: {
  feed: ReturnType<typeof useGithubFeed>["feed"];
  loading: boolean;
  visible: GithubItem[];
  query: ParsedQuery;
  opening: string | null;
  onOpen: (item: GithubItem) => void;
  onOpenInBrowser: (url: string) => void;
  onSignIn: (token: string) => Promise<void>;
  onSignedIn: () => void;
}) {
  // Only before the first reply. A refresh over a list already on screen dims
  // it instead, which is what the `loading` class on the list is for — replacing
  // a list with a spinner on every refresh loses the reader's place.
  if (feed === null) {
    return <Empty title={loading ? "Asking GitHub…" : ""} />;
  }

  if (feed.state === "notGithub") {
    return (
      <Empty
        title="This project has no GitHub remote."
        detail="Issues and pull requests come from the repository `origin` points at. A checkout with no remote, or one hosted somewhere else, has none to show."
      />
    );
  }

  if (feed.state === "unavailable") {
    return (
      <Trouble
        trouble={feed.trouble}
        repo={feed.repo}
        onSignIn={onSignIn}
        onSignedIn={onSignedIn}
      />
    );
  }

  if (visible.length === 0) {
    // Two different emptinesses, and they need two different sentences. The
    // buttons are on screen and their effect can be seen, so an empty list
    // under them is a fact about the repository; a word typed into the box is
    // not, and only then is "nothing matches" the honest answer.
    return narrowsByText(query) ? (
      <Empty title="Nothing matches that filter." detail="Clearing the box brings the list back." />
    ) : (
      <Empty
        title={`No ${describeQuery(query)}.`}
        detail={`${feed.repo} has none. The buttons above switch between issues, pull requests, and closed or merged work.`}
      />
    );
  }

  return (
    <>
      <ul className={`github__list${loading ? " github__list--stale" : ""}`}>
        {visible.map((item) => (
          <Row
            key={item.id}
            item={item}
            opening={opening === item.id}
            disabled={opening !== null}
            onOpen={onOpen}
            onOpenInBrowser={onOpenInBrowser}
          />
        ))}
      </ul>
      {!feed.authenticated && <SignedOutHint />}
    </>
  );
}

function Row({
  item,
  opening,
  disabled,
  onOpen,
  onOpenInBrowser,
}: {
  item: GithubItem;
  opening: boolean;
  disabled: boolean;
  onOpen: (item: GithubItem) => void;
  onOpenInBrowser: (url: string) => void;
}) {
  const Glyph = item.kind === "pull" ? PullRequest : IssueDot;

  return (
    <li className="github__row">
      <span
        className="github__kind"
        style={{ color: GITHUB_STATE_TOKEN[item.state] }}
        title={`${item.kind === "pull" ? "Pull request" : "Issue"} — ${GITHUB_STATE_LABEL[item.state]}`}
      >
        <Glyph />
      </span>

      <div className="github__main">
        <button
          type="button"
          className="github__title"
          onClick={() => onOpenInBrowser(item.url)}
          title={`${item.title}\nOpen #${item.number} on github.com`}
        >
          <span className="github__number">#{item.number}</span> {item.title}
        </button>

        <div className="github__meta">
          {/* Spelled out as well as tinted. The glyph already carries the state
              as a colour, and colour alone is not a label — a merged pull
              request and a closed one differ by hue and nothing else, which is
              the distinction somebody scanning a closed list most needs. */}
          <span className="github__state" style={{ color: GITHUB_STATE_TOKEN[item.state] }}>
            {GITHUB_STATE_LABEL[item.state]}
          </span>
          {item.author && <span className="github__author">{item.author}</span>}
          {item.headBranch && (
            <span className="github__branch" title="The pull request's own branch">
              {item.headBranch}
            </span>
          )}
          {item.labels.slice(0, 3).map((label) => (
            <span key={label} className="github__label">
              {label}
            </span>
          ))}
        </div>
      </div>

      <button
        type="button"
        className="github__open"
        onClick={() => onOpen(item)}
        disabled={disabled}
        // The title says what will actually happen, including the part that
        // surprises people: a pull request gets a *new* branch named after it
        // rather than a checkout of the author's. `github.rs` explains why.
        title={`Create the worktree ${item.suggestedBranch} and move this cluster onto it`}
      >
        {opening ? "Opening…" : "Open"}
      </button>
    </li>
  );
}

/** Why the list could not be fetched, and the one thing to do about it. */
function Trouble({
  trouble,
  repo,
  onSignIn,
  onSignedIn,
}: {
  trouble: GithubTrouble;
  repo: string | null;
  onSignIn: (token: string) => Promise<void>;
  onSignedIn: () => void;
}) {
  const where = repo ?? "this repository";

  switch (trouble.kind) {
    case "auth":
      return (
        <SignIn
          title="GitHub would not accept that."
          detail={`Reading ${where} needs a personal access token with repo access.`}
          onSignIn={onSignIn}
          onSignedIn={onSignedIn}
        />
      );

    case "missingOrPrivate":
      return (
        <SignIn
          title={`${where} could not be read.`}
          // The two causes are deliberately not separated, because GitHub does
          // not separate them either — it answers 404 for a private repository
          // precisely so that its existence is not leaked, and guessing here
          // would undo that.
          detail="It does not exist, or the account signed in cannot see it. Signing in with an account that can will tell you which."
          onSignIn={onSignIn}
          onSignedIn={onSignedIn}
        />
      );

    case "rateLimited":
      return (
        <SignIn
          title="GitHub's hourly limit is used up."
          detail={
            (trouble.resetsInMinutes === null
              ? "It resets within the hour."
              : `It resets in about ${trouble.resetsInMinutes} minute${trouble.resetsInMinutes === 1 ? "" : "s"}.`) +
            " Signing in raises the limit from 60 requests an hour to 5000."
          }
          onSignIn={onSignIn}
          onSignedIn={onSignedIn}
        />
      );

    case "unreachable":
      return <Empty title="Could not reach GitHub." detail={trouble.reason} />;
  }
}

/**
 * The token field.
 *
 * A password input, and the value is handed straight to Rust and dropped — this
 * component never stores it beyond the keystroke and nothing reads it back. The
 * same token the app library's own sign-in writes; one host, one credential.
 */
function SignIn({
  title,
  detail,
  onSignIn,
  onSignedIn,
}: {
  title: string;
  detail: string;
  onSignIn: (token: string) => Promise<void>;
  onSignedIn: () => void;
}) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = token.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    void onSignIn(trimmed)
      .then(() => {
        setToken("");
        setSaving(false);
        onSignedIn();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setError(String(err));
      });
  };

  return (
    <div className="github__empty">
      <p className="github__emptytitle">{title}</p>
      <p className="github__emptydetail">{detail}</p>
      <div className="github__signin">
        <input
          className="github__token"
          type="password"
          value={token}
          spellCheck={false}
          autoComplete="off"
          placeholder="ghp_…"
          aria-label="GitHub personal access token"
          onChange={(event) => setToken(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
        <button
          type="button"
          className="github__signinbtn"
          onClick={submit}
          disabled={saving || token.trim().length === 0}
        >
          {saving ? "Saving…" : "Sign in"}
        </button>
      </div>
      <p className="github__emptydetail">
        Stored in Windows Credential Manager, not in OpenKaava&apos;s settings file.
      </p>
      {error && (
        <p className="github__failure" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Quiet, and under a list that is working: an anonymous list is real, it is
 *  just capped and cannot see anything private. Nothing to do about it now. */
function SignedOutHint() {
  return (
    <p className="github__hint">Signed out — public repositories only, and 60 requests an hour.</p>
  );
}

function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="github__empty">
      {title && <p className="github__emptytitle">{title}</p>}
      {detail && <p className="github__emptydetail">{detail}</p>}
    </div>
  );
}
