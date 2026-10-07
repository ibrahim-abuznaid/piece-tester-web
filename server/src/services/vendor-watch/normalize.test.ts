import { describe, it, expect } from 'vitest';
import {
  parseFeed, normalizeFeed, newFeedEntries, newestEntries, renderFeedEntries,
  htmlBlocks, normalizeHtml, addedHtmlBlocks, renderBlocks, htmlToText,
} from './normalize.js';

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Acme API changelog</title>
<item><title>Deprecating /v1/widgets</title><link>https://acme.dev/changelog/1</link><guid isPermaLink="false">0042</guid><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;The &lt;b&gt;/v1/widgets&lt;/b&gt; endpoint will be removed on 2027-01-31.&lt;/p&gt;</description></item>
<item><title>New webhooks</title><link>https://acme.dev/changelog/2</link><guid>https://acme.dev/changelog/2</guid><pubDate>Mon, 01 Jun 2026 10:00:00 GMT</pubDate><description>Webhooks for orders.</description></item>
</channel></rss>`;

const ATOM_ONE_ENTRY = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Releases</title>
<entry><id>tag:github.com,2008:Repository/1/v2.0.0</id><title>v2.0.0</title><updated>2026-09-20T00:00:00Z</updated>
<link rel="alternate" type="text/html" href="https://github.com/acme/sdk/releases/tag/v2.0.0"/>
<content type="html">&lt;h2&gt;Breaking&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;Removed legacy auth&lt;/li&gt;&lt;/ul&gt;</content></entry>
</feed>`;

const RSS_NO_IDS = `<rss><channel><item><title>Quiet change</title><pubDate>Wed, 02 Sep 2026 00:00:00 GMT</pubDate><description>Something long enough to matter here.</description></item></channel></rss>`;

describe('parseFeed', () => {
  it('reads RSS items, keeping string guids and stripping HTML from descriptions', () => {
    const entries = parseFeed(RSS);
    expect(entries.map(e => e.id)).toEqual(['0042', 'https://acme.dev/changelog/2']);
    expect(entries[0].title).toBe('Deprecating /v1/widgets');
    expect(entries[0].text).toBe('The /v1/widgets endpoint will be removed on 2027-01-31.');
    expect(entries[0].link).toBe('https://acme.dev/changelog/1');
    expect(entries[0].date).toBe('Tue, 01 Sep 2026 10:00:00 GMT');
  });

  it('reads a single-entry Atom feed (object, not array) with href links and html content', () => {
    const [e] = parseFeed(ATOM_ONE_ENTRY);
    expect(e.id).toBe('tag:github.com,2008:Repository/1/v2.0.0');
    expect(e.link).toBe('https://github.com/acme/sdk/releases/tag/v2.0.0');
    expect(e.text).toBe('Breaking Removed legacy auth');
  });

  it('gives an item with no guid or link a stable id', () => {
    const a = parseFeed(RSS_NO_IDS);
    const b = parseFeed(RSS_NO_IDS);
    expect(a).toHaveLength(1);
    expect(a[0].id).toMatch(/^[0-9a-f]{40}$/);
    expect(a[0].id).toBe(b[0].id);
  });

  it('returns nothing for a non-feed document', () => {
    expect(parseFeed('<html><body>hi</body></html>')).toEqual([]);
  });
});

describe('feed snapshots', () => {
  it('hashes ids independent of order and finds only unseen entries', () => {
    const entries = parseFeed(RSS);
    const n1 = normalizeFeed(entries);
    expect(normalizeFeed([...entries].reverse()).hash).toBe(n1.hash);
    const fresh = newFeedEntries(entries, JSON.stringify(['0042']));
    expect(fresh.map(e => e.id)).toEqual(['https://acme.dev/changelog/2']);
  });

  it('orders the newest entries first when every entry has a date', () => {
    const entries = parseFeed(RSS);
    expect(newestEntries([...entries].reverse(), 1).map(e => e.id)).toEqual(['0042']);
  });

  it('renders entries with title, date, link and text', () => {
    const out = renderFeedEntries(parseFeed(RSS).slice(0, 1));
    expect(out).toBe('## Deprecating /v1/widgets (Tue, 01 Sep 2026 10:00:00 GMT)\nhttps://acme.dev/changelog/1\nThe /v1/widgets endpoint will be removed on 2027-01-31.');
  });
});

const PAGE = `<html><head><title>Changelog</title><script>var x = 1;</script></head>
<body><nav><a href="/">Home</a> navigation links that are long enough to count</nav>
<main>
<h2>2026-09-01</h2>
<p>The legacy /v1/widgets endpoint is deprecated and will be removed on 2027-01-31.</p>
<ul><li>Added cursor pagination to the list orders endpoint.<ul><li>Nested detail line that is long enough.</li></ul></li></ul>
<h2>2026-08-01</h2>
<p>Short.</p>
<p>Rate limits for the search endpoint went from 100 to 200 per minute.</p>
</main>
<footer>Copyright Acme Inc. All rights reserved. Long footer text here.</footer>
</body></html>`;

describe('htmlBlocks', () => {
  it('keeps main-content blocks with their heading, drops chrome, short blocks and nested duplicates', () => {
    expect(htmlBlocks(PAGE)).toEqual([
      { text: 'The legacy /v1/widgets endpoint is deprecated and will be removed on 2027-01-31.', heading: '2026-09-01' },
      { text: 'Added cursor pagination to the list orders endpoint. Nested detail line that is long enough.', heading: '2026-09-01' },
      { text: 'Rate limits for the search endpoint went from 100 to 200 per minute.', heading: '2026-08-01' },
    ]);
  });

  it('htmlToText keeps a space between block elements', () => {
    expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One Two');
  });
});

describe('html snapshots', () => {
  it('ignores reordering and reports only added blocks, under their heading', () => {
    const before = normalizeHtml(htmlBlocks(PAGE));
    const reordered = PAGE.replace(/<h2>2026-09-01<\/h2>[\s\S]*?(?=<h2>2026-08-01)/, '')
      .replace('</main>', '<h2>2026-09-01</h2><p>The legacy /v1/widgets endpoint is deprecated and will be removed on 2027-01-31.</p><ul><li>Added cursor pagination to the list orders endpoint.<ul><li>Nested detail line that is long enough.</li></ul></li></ul></main>');
    expect(normalizeHtml(htmlBlocks(reordered)).hash).toBe(before.hash);
    expect(addedHtmlBlocks(htmlBlocks(reordered), before.content)).toEqual([]);

    const after = PAGE.replace('<main>', '<main><h2>2026-10-01</h2><p>OAuth tokens now expire after 12 hours instead of never expiring.</p>');
    const added = addedHtmlBlocks(htmlBlocks(after), before.content);
    expect(added).toEqual([{ text: 'OAuth tokens now expire after 12 hours instead of never expiring.', heading: '2026-10-01' }]);
    expect(renderBlocks(added)).toBe('## 2026-10-01\n- OAuth tokens now expire after 12 hours instead of never expiring.');
  });
});
