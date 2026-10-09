// Plain ESM (not TS) so a worker_thread can load it without a TS loader. Types: extract-core.d.mts.
import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

export const MAX_HTML_BYTES = 5 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 1024 * 1024;

function cleanDocument(document, baseUrl) {
  document.querySelectorAll('script, style, noscript, nav, footer, iframe, object, embed, form, input, button, textarea, select, svg, canvas, link, meta, [hidden], [aria-hidden="true"], [role="navigation"], [role="contentinfo"]').forEach((node) => node.remove());
  document.querySelectorAll('*').forEach((node) => {
    for (const attribute of Array.from(node.attributes)) {
      if (/^on/i.test(attribute.name) || ['srcdoc', 'style', 'srcset'].includes(attribute.name)) node.removeAttribute(attribute.name);
    }
    for (const attribute of ['href', 'src']) {
      const value = node.getAttribute(attribute);
      if (value === null) continue;
      try {
        const url = new URL(value, baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) node.removeAttribute(attribute);
        else node.setAttribute(attribute, url.href);
      } catch { node.removeAttribute(attribute); }
    }
  });
}

function asText(element) {
  const copy = element.cloneNode(true);
  copy.querySelectorAll('br').forEach((node) => node.replaceWith('\n'));
  copy.querySelectorAll('p, div, section, article, h1, h2, h3, h4, h5, h6, li, tr, pre, blockquote').forEach((node) => node.append('\n'));
  copy.querySelectorAll('td, th').forEach((node) => node.append('\t'));
  return (copy.textContent ?? '').replace(/\n[ \t]+\n/g, '\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

let turndownService;
// Stateless between calls; building the rule set per page is pure overhead.
function getTurndown() {
  if (!turndownService) {
    turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', fence: '```' });
    turndownService.use(gfm);
  }
  return turndownService;
}

export function extractHtml(html, url, format = 'markdown', mode = 'auto') {
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw new Error('TOO_LARGE: Rendered HTML exceeds the 5 MiB limit.');
  // No runScripts/resources: extraction never executes scripts or loads URLs.
  // Suppress jsdom diagnostics from malformed third-party HTML/CSS; they are
  // neither actionable to the agent nor a fetch failure.
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  try {
    const document = dom.window.document;
    const warnings = [];
    const title = document.title.trim();
    const visible = `${title}\n${document.body?.textContent ?? ''}`.slice(0, 100_000);
    if (/just a moment|checking your browser|verify (?:that )?you are human|captcha|access denied|cf-chl-|challenge-platform/i.test(visible) || document.querySelector('[id^="cf-chl"], [class*="captcha"]')) {
      warnings.push('This page appears to contain a bot challenge or access restriction; content may be incomplete.');
    }
    if (document.querySelector('input[type="password"]') || /\b(?:sign in|log in|login)\b.{0,60}\b(?:required|to continue|to view|to access)\b/i.test(visible)) {
      warnings.push('This page appears to require login; only unauthenticated content was fetched.');
    }
    // Resolve URLs before Readability moves nodes; ignore page-supplied <base> elements.
    document.querySelectorAll('base').forEach((node) => node.remove());
    cleanDocument(document, url);
    let selected = null;
    let extraction = mode;
    let extractedTitle = title;
    if (mode === 'auto') {
      try {
        const article = new Readability(document.cloneNode(true), { keepClasses: true }).parse();
        if (article?.content && article.textContent?.trim()) {
          const container = document.createElement('div');
          container.innerHTML = article.content;
          selected = container;
          extractedTitle ||= article.title ?? '';
          extraction = 'readability';
        }
      } catch { warnings.push('Article extraction failed; using the main/body fallback.'); }
    }
    if (!selected && mode !== 'body') {
      const main = document.querySelector('main, [role="main"], article');
      if (main?.textContent?.trim()) { selected = main; extraction = 'main'; }
      else if (mode === 'main') warnings.push('No non-empty main element found; using the document body.');
    }
    if (!selected) { selected = document.body; extraction = 'body'; }
    if (!selected?.textContent?.trim()) throw new Error('EMPTY_CONTENT: The page has no extractable text.');
    let content;
    if (format === 'text') content = asText(selected);
    else {
      content = getTurndown().turndown(selected.innerHTML).trim();
    }
    if (!content.trim()) throw new Error('EMPTY_CONTENT: The page has no extractable content.');
    if (Buffer.byteLength(content, 'utf8') > MAX_EXTRACTED_BYTES) {
      // Tool output is clipped far below this limit; truncate instead of failing.
      content = Buffer.from(content, 'utf8').subarray(0, MAX_EXTRACTED_BYTES).toString('utf8').replace(/�+$/u, '');
      warnings.push('Extracted content exceeded 1 MiB and was truncated.');
    }
    return { title: extractedTitle, content, extraction, warnings };
  } finally {
    dom.window.close();
  }
}
