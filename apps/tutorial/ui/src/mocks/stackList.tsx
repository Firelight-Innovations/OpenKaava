/** The switcher bar's health popover, mid-setup — see `HealthPopover.tsx`.
 *
 *  Three things here are the real component's rules rather than a choice.
 *  Only unwell tools have rows, so a healthy one is absent instead of green;
 *  only authoring tools can appear, because `WindowRoot` filters the list to
 *  `kind === "dev-tool"`; and the words are `HEALTH_LABEL`'s, never the
 *  backend's `mismatch` / `unversioned` / `missing`, which `contract.ts` keeps
 *  off the screen on purpose.
 *
 *  Tones follow `HEALTH_TOKEN`: both "needs update" and "not tracked" warn,
 *  "not installed" errs, which is the point `theStack.ts` spends its middle
 *  section on. Nothing is actually pinned in `veistra.toml` today, so an empty
 *  popover — not this one — is what a fresh machine shows; see the note below. */
import { Chip, Col, Row } from "./chrome";

/** One row per unwell tool, in the order `veistra.toml` pins them.
 *
 *  Illustrative names, not real ones. Two real entries used to make this
 *  screen real; both are now the single Schematify app (see
 *  `apps/README.md`), and `veistra.toml`'s `[[tool]]` array is empty, so this
 *  mocks a hypothetical third-party tool pair rather than a live state. */
const UNWELL: { name: string; tone: "warn" | "err"; label: string }[] = [
  { name: "Example Tool", tone: "err", label: "not installed" },
  { name: "Another Tool", tone: "warn", label: "needs update" },
];

export default function StackList() {
  return (
    <Col gap="xs">
      <Row justify="between" align="center">
        <span className="tut__mock-caption">TOOL HEALTH</span>
        <Chip tone="warn">{UNWELL.length}</Chip>
      </Row>
      {UNWELL.map((tool) => (
        <Row key={tool.name} justify="between" align="center">
          <span className="tut__mock-caption">{tool.name}</span>
          <Chip tone={tool.tone}>{tool.label}</Chip>
        </Row>
      ))}
    </Col>
  );
}
