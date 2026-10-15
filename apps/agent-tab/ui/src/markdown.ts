/**
 * The agent's replies as sanitised HTML.
 *
 * Stricter than the File Viewer's (`apps/viewer/ui/src/preview/markdown.ts`):
 * an agent's text is not a README, so raw HTML is off at the parser as well as
 * removed by DOMPurify afterwards. An image is drawn as its alt text, so an
 * agent's reply never makes the tab fetch a URL. Each fenced block gets a copy
 * button, which `AssistantItem` in `Items.tsx` answers by event delegation (the `AssistantText`
 * slot only carries the handlers).
 */
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { strings } from "./strings";

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });

md.renderer.rules.image = (tokens, idx) => md.utils.escapeHtml(tokens[idx].content);

const fence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const inner = fence
    ? fence(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
  return `<div class="at-code"><button type="button" class="at-code__copy" data-copy>${strings.copy}</button>${inner}</div>`;
};

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(md.render(text), { USE_PROFILES: { html: true } });
}
