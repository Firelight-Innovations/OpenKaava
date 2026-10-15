// Generated from src-tauri/src/refs/catalogue.rs and resolve.rs by ts-rs. Do not edit.
// Regenerate: KAAVA_BLESS=1 cargo test --lib refs::catalogue::tests::generated

export type KaavaShow = { version: number, } & ({ "component": "refs", "props": RefsProps } | { "component": "callout", "props": CalloutProps } | { "component": "steps", "props": StepsProps } | { "component": "table", "props": TableProps } | { "component": "compare", "props": CompareProps } | { "component": "diagram", "props": DiagramProps } | { "component": "chart", "props": ChartProps } | { "component": "choice", "props": ChoiceProps });

export type Component = { "component": "refs", "props": RefsProps } | { "component": "callout", "props": CalloutProps } | { "component": "steps", "props": StepsProps } | { "component": "table", "props": TableProps } | { "component": "compare", "props": CompareProps } | { "component": "diagram", "props": DiagramProps } | { "component": "chart", "props": ChartProps } | { "component": "choice", "props": ChoiceProps };

export type RefsProps = { 
/**
 * `kaava://` references, in the order they are drawn.
 */
refs: Array<string>, 
/**
 * One line above them.
 */
caption?: string, };

export type CalloutProps = { tone: Tone, title?: string, body: string, refs: Array<string>, };

export type Tone = "note" | "tip" | "warning" | "danger";

export type StepsProps = { title?: string, steps: Array<Step>, };

export type Step = { title: string, body?: string, status?: StepStatus, refs: Array<string>, };

export type StepStatus = "todo" | "doing" | "done" | "skipped";

export type TableProps = { caption?: string, columns: Array<Column>, 
/**
 * One cell per column in every row.
 */
rows: Array<Array<Cell | null>>, };

export type Column = { label: string, align?: Align, };

export type Align = "left" | "right" | "center";

export type Cell = string | number | boolean;

export type CompareProps = { title?: string, items: Array<Compared>, 
/**
 * The index of the item the agent recommends.
 */
recommended?: number, };

export type Compared = { title: string, body?: string, pros: Array<string>, cons: Array<string>, refs: Array<string>, };

export type DiagramProps = { format: DiagramFormat, source: string, title?: string, };

export type DiagramFormat = "mermaid";

export type ChartProps = { type: ChartKind, title?: string, xLabels: Array<string>, 
/**
 * Each with one value per x label.
 */
series: Array<Series>, yLabel?: string, };

export type ChartKind = "bar" | "line" | "area";

export type Series = { name: string, values: Array<number>, };

export type ChoiceProps = { question: string, options: Array<ChoiceOption>, 
/**
 * Whether they may pick more than one.
 */
multiple: boolean, };

export type ChoiceOption = { 
/**
 * Letters, digits, `_` and `-`, unique within the choice.
 */
id: string, label: string, detail?: string, };

export type Resolved = { 
/**
 * The canonical form of the reference that was resolved.
 */
uri: string, 
/**
 * `text`, `image`, `model`, `scene`, `audio`, `video`, `binary`, `folder`,
 * `canvas`, `frame`, `comment`, `design-comment`, `context` or `selection`.
 */
kind: string, 
/**
 * A short label: a file name, a frame name, a comment's first line.
 */
title: string, detail?: string, meta: Record<string, unknown>, parts: Array<Part>, 
/**
 * Why nothing (or less) was read. Set for secrets, gitignored files and
 * anything over a cap; `parts` then carries no content from the file.
 */
withheld?: string, };

export type Part = { "type": "text", text: string, language?: string, 
/**
 * The file line `text` starts at, 1-based.
 */
startLine: number, truncated: boolean, } | { "type": "image", mime: string, dataBase64: string, width: number, height: number, } | { "type": "json", value: unknown, } | { "type": "note", text: string, };
