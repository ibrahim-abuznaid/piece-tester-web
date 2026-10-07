import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { parse as parseHtml, type HTMLElement } from 'node-html-parser';

export interface Normalized {
  hash: string;
  content: string;
}

export interface FeedEntry {
  id: string;
  title: string;
  date: string | null;
  text: string;
  link: string;
}

export interface HtmlBlock {
  text: string;
  /**
   * The nearest heading above the block (often a release date), kept as context for the classifier.
   * For a heading block, the nearest heading of a higher level.
   */
  heading: string | null;
}

export const MIN_BLOCK_CHARS = 30;

export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const BLOCK_TAG = /<(\/?)(p|div|li|h[1-6]|tr|td|th|dt|dd|ul|ol|pre|blockquote|section|article|table)\b/gi;

/** Put a newline before every block tag so adjacent blocks don't glue together as text. */
function spaceBlocks(html: string): string {
  return html.replace(BLOCK_TAG, '\n<$1$2').replace(/<br\s*\/?>/gi, '\n');
}

/** The parser's default also keeps `<pre>` raw, which leaks highlighter markup into the text. */
const HTML_OPTIONS = { blockTextElements: { script: true, noscript: true, style: true } };

export function htmlToText(fragment: string): string {
  return collapseWhitespace(parseHtml(`<div>${spaceBlocks(fragment)}</div>`, HTML_OPTIONS).text);
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

// ── Feeds ──

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && '#text' in (v as Record<string, unknown>)) return String((v as Record<string, unknown>)['#text']);
  return '';
}

function atomLink(link: unknown): string {
  const links = asArray(link as any);
  const alt = links.find((l: any) => !l?.['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
  return typeof alt === 'string' ? alt : alt?.['@_href'] ?? '';
}

/** RSS 2.0, RSS 1.0 (RDF) and Atom. Returns [] for anything that isn't a feed. */
export function parseFeed(body: string): FeedEntry[] {
  const doc = xml.parse(body);
  const rssItems = [...asArray(doc?.rss?.channel?.item), ...asArray(doc?.['rdf:RDF']?.item)];
  const fromRss = rssItems.map((it: any): FeedEntry => {
    const link = textOf(it.link);
    const title = htmlToText(textOf(it.title));
    const date = textOf(it.pubDate) || textOf(it['dc:date']) || null;
    const text = htmlToText(textOf(it['content:encoded']) || textOf(it.description));
    return { id: textOf(it.guid) || link || sha1(`${title}|${date ?? ''}`), title, date, text, link };
  });
  const fromAtom = asArray(doc?.feed?.entry).map((e: any): FeedEntry => {
    const link = atomLink(e.link);
    const title = htmlToText(textOf(e.title));
    const date = textOf(e.updated) || textOf(e.published) || null;
    const text = htmlToText(textOf(e.content) || textOf(e.summary));
    return { id: textOf(e.id) || link || sha1(`${title}|${date ?? ''}`), title, date, text, link };
  });
  return uniqueIds([...fromRss, ...fromAtom]);
}

/** Every entry whose id is shared (e.g. guid-less items that all link to /changelog) gets sha1(id|title|date) instead. */
function uniqueIds(entries: FeedEntry[]): FeedEntry[] {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
  return entries.map(e => (counts.get(e.id)! > 1 ? { ...e, id: sha1(`${e.id}|${e.title}|${e.date ?? ''}`) } : e));
}

export function normalizeFeed(entries: FeedEntry[]): Normalized {
  const ids = entries.map(e => e.id);
  return { hash: sha1([...ids].sort().join('\n')), content: JSON.stringify(ids) };
}

export function newFeedEntries(entries: FeedEntry[], previousContent: string): FeedEntry[] {
  const seen = new Set(safeJsonArray(previousContent));
  return entries.filter(e => !seen.has(e.id));
}

/** Newest first when every entry has a parseable date; otherwise document order. */
export function newestEntries(entries: FeedEntry[], n: number): FeedEntry[] {
  const dated = entries.map(e => ({ e, t: e.date ? Date.parse(e.date) : NaN }));
  if (dated.every(d => !Number.isNaN(d.t))) dated.sort((a, b) => b.t - a.t);
  return dated.slice(0, n).map(d => d.e);
}

export function renderFeedEntries(entries: FeedEntry[]): string {
  return entries
    .map(e => [`## ${e.title}${e.date ? ` (${e.date})` : ''}`, e.link, e.text].filter(Boolean).join('\n'))
    .join('\n\n');
}

// ── HTML pages ──

const DROP_SELECTORS = 'script, style, noscript, nav, header, footer, aside, svg, form';
const BLOCK_SELECTORS = 'h1, h2, h3, h4, h5, h6, p, li, tr, dt, dd, pre, blockquote';
const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const BLOCK_TAGS = new Set(['P', 'LI', 'TR', 'DT', 'DD', 'PRE', 'BLOCKQUOTE']);

function hasBlockAncestor(el: HTMLElement, stop: HTMLElement): boolean {
  for (let p = el.parentNode; p && p !== stop; p = p.parentNode) {
    if (BLOCK_TAGS.has(p.tagName)) return true;
  }
  return false;
}

/** `<main>`, else the page's only `<article>`, else `<body>`. A page with one article per entry is read whole. */
function contentRoot(root: HTMLElement): HTMLElement {
  const main = root.querySelector('main');
  if (main) return main;
  const articles = root.querySelectorAll('article');
  return articles.length === 1 ? articles[0] : root.querySelector('body') ?? root;
}

/** The readable blocks of a docs/changelog page, each with the heading above it. Long headings are blocks too. */
export function htmlBlocks(html: string): HtmlBlock[] {
  const root = parseHtml(spaceBlocks(html), HTML_OPTIONS);
  for (const n of root.querySelectorAll(DROP_SELECTORS)) n.remove();
  const main = contentRoot(root);
  const out: HtmlBlock[] = [];
  const seen = new Set<string>();
  // headings[n] is the latest <hn> still in scope.
  const headings: string[] = [];
  let heading: string | null = null;
  for (const el of main.querySelectorAll(BLOCK_SELECTORS)) {
    const text = collapseWhitespace(el.text);
    let above = heading;
    if (HEADING_TAGS.has(el.tagName)) {
      if (!text) continue;
      const level = Number(el.tagName[1]);
      above = headings.slice(0, level).filter(Boolean).pop() ?? null;
      headings.length = level;
      heading = headings[level] = text.slice(0, 200);
    }
    if (hasBlockAncestor(el, main) || text.length < MIN_BLOCK_CHARS || seen.has(text)) continue;
    seen.add(text);
    out.push({ text, heading: above });
  }
  return out;
}

export function normalizeHtml(blocks: HtmlBlock[]): Normalized {
  const hashes = blocks.map(b => sha1(b.text));
  return { hash: sha1([...hashes].sort().join('\n')), content: JSON.stringify(hashes) };
}

export function addedHtmlBlocks(blocks: HtmlBlock[], previousContent: string): HtmlBlock[] {
  const seen = new Set(safeJsonArray(previousContent));
  return blocks.filter(b => !seen.has(sha1(b.text)));
}

export function renderBlocks(blocks: HtmlBlock[]): string {
  const lines: string[] = [];
  let current: string | null | undefined;
  for (const b of blocks) {
    if (b.heading !== current) {
      if (b.heading) lines.push(`## ${b.heading}`);
      current = b.heading;
    }
    lines.push(`- ${b.text}`);
  }
  return lines.join('\n');
}
