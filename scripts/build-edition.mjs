// Fetches the RSS feeds, extracts full article text with Mozilla's
// Readability library, and writes the result to data/edition.json.
// Run automatically every evening by a GitHub Actions workflow —
// see .github/workflows/build-edition.yml
//
// Uses only Node's built-in fetch (Node 18+) plus two small libraries
// (linkedom, @mozilla/readability) — no server, no third-party proxy.

import { writeFile, mkdir } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

const FEEDS = {
  canberra: { url: 'https://the-riotact.com/feed', label: 'Riotact | Canberra' },
  australia: { url: 'https://www.theguardian.com/australia-news/rss', label: 'The Guardian | National' },
  world: { url: 'https://www.theguardian.com/world/rss', label: 'The Guardian | International' }
};

const ARTICLES_PER_SECTION = 5;
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; EveningEditionBot/1.0; +for personal use)'
};

async function main() {
  const targetDate = getTargetEditionDate();
  console.log(`Building edition for ${targetDate}...`);

  const [canberra, australia, world] = await Promise.all([
    buildSection(FEEDS.canberra, ARTICLES_PER_SECTION),
    buildSection(FEEDS.australia, ARTICLES_PER_SECTION),
    buildSection(FEEDS.world, ARTICLES_PER_SECTION)
  ]);

  const edition = {
    date: targetDate,
    generatedAt: new Date().toISOString(),
    canberra: canberra.items,
    australia: australia.items,
    world: world.items,
    warnings: [canberra.error, australia.error, world.error].filter(Boolean)
  };

  const hasContent =
    edition.canberra.length > 0 || edition.australia.length > 0 || edition.world.length > 0;

  if (!hasContent) {
    console.error('All sections came back empty — leaving the existing data/edition.json untouched.');
    process.exit(1); // fail the workflow so it doesn't commit a blank edition
  }

  await mkdir('data', { recursive: true });
  await writeFile('data/edition.json', JSON.stringify(edition, null, 2));

  console.log(
    `Done. canberra: ${edition.canberra.length}, australia: ${edition.australia.length}, world: ${edition.world.length}`
  );
  if (edition.warnings.length) {
    console.warn('Warnings:', edition.warnings);
  }
}

// ---- Edition assembly ----

async function buildSection(feedConf, count) {
  let items = [];
  try {
    items = await fetchFeedItems(feedConf.url, feedConf.label);
  } catch (e) {
    return { items: [], error: `${feedConf.label}: ${e.message}` };
  }

  const top = items.slice(0, count);
  const results = [];
  for (const item of top) {
    let content = item.fallbackContent;
    let imageUrl = item.imageUrl;

    const full = await extractFullArticle(item.link);
    if (full && full.content && full.content.length > 200) {
      content = full.content;
      if (full.imageUrl) imageUrl = full.imageUrl;
    }

    results.push({
      title: item.title,
      link: item.link,
      snippet: item.snippet,
      content: content || `<p>${item.snippet}</p>`,
      imageUrl,
      source: feedConf.label
    });
  }

  return { items: results, error: null };
}

// ---- RSS fetching & parsing (regex-based, no artificial entity limits) ----

async function fetchFeedItems(feedUrl, label) {
  const res = await fetch(feedUrl, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`feed returned ${res.status}`);
  const xml = await res.text();

  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return itemBlocks.map((block) => normalizeItemFromXml(block, label));
}

function extractTagRaw(block, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function unwrapCdataOrDecode(raw) {
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1];
  return decodeEntities(raw);
}

function extractAttr(tagXml, attrName) {
  const re = new RegExp(`\\s${attrName}\\s*=\\s*["']([^"']*)["']`, 'i');
  const m = tagXml.match(re);
  return m ? m[1] : null;
}

function normalizeItemFromXml(block, label) {
  const title = unwrapCdataOrDecode(extractTagRaw(block, 'title')).trim();

  let link = unwrapCdataOrDecode(extractTagRaw(block, 'link')).trim();
  if (!link) {
    const atomLinkMatch = block.match(/<link[^>]*\shref=["']([^"']+)["'][^>]*\/?>/i);
    if (atomLinkMatch) link = atomLinkMatch[1];
  }

  const description = unwrapCdataOrDecode(extractTagRaw(block, 'description'));
  const contentEncodedRaw = extractTagRaw(block, 'content:encoded');
  const contentEncoded = contentEncodedRaw ? unwrapCdataOrDecode(contentEncodedRaw) : '';

  let imageUrl = null;
  const thumbMatch = block.match(/<media:thumbnail[^>]*\surl=["']([^"']+)["'][^>]*\/?>/i);
  if (thumbMatch) imageUrl = thumbMatch[1];
  if (!imageUrl) {
    const encBlockMatch = block.match(/<enclosure\b[^>]*\/?>/i);
    if (encBlockMatch) {
      const encTag = encBlockMatch[0];
      const type = extractAttr(encTag, 'type');
      if (type && type.includes('image')) {
        imageUrl = extractAttr(encTag, 'url');
      }
    }
  }
  if (!imageUrl) imageUrl = firstImageSrc(contentEncoded) || firstImageSrc(description);

  return {
    title,
    link,
    snippet: snippetFrom(description),
    fallbackContent: paragraphsFrom(contentEncoded || description),
    imageUrl,
    source: label
  };
}

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rdquo;/g, '\u201D')
    .replace(/&ldquo;/g, '\u201C')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&hellip;/g, '\u2026')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function firstImageSrc(html) {
  const m = (html || '').match(/<img[^>]+src="([^">]+)"/);
  return m ? m[1] : null;
}

function snippetFrom(html, max = 140) {
  const text = stripTags(html);
  return text.length > max ? text.slice(0, max - 3) + '...' : text;
}

function stripTags(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function paragraphsFrom(html) {
  const text = stripTags(html);
  return text ? `<p>${text}</p>` : '';
}

// ---- Full article extraction via Readability ----

async function extractFullArticle(articleUrl) {
  try {
    const res = await fetch(articleUrl, { headers: FETCH_HEADERS });
    if (!res.ok) return null;
    const html = await res.text();

    const { document } = parseHTML(html);

    let ogImage = null;
    const ogMeta = document.querySelector('meta[property="og:image"]');
    if (ogMeta) ogImage = ogMeta.getAttribute('content');
    if (!ogImage) {
      const twitterMeta = document.querySelector('meta[name="twitter:image"]');
      if (twitterMeta) ogImage = twitterMeta.getAttribute('content');
    }
    if (ogImage && !ogImage.startsWith('http')) {
      try { ogImage = new URL(ogImage, articleUrl).href; } catch (e) { /* leave as-is */ }
    }

    const reader = new Readability(document);
    const article = reader.parse();
    if (!article || !article.content) return null;

    return { content: cleanArticleHtml(article.content), imageUrl: ogImage };
  } catch (e) {
    return null;
  }
}

function cleanArticleHtml(html) {
  return html
    .replace(/<(script|style|iframe|noscript|form|svg|button)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\sstyle="[^"]*"/gi, '');
}

// ---- Edition date logic (Sydney time, rolls over at 5pm) ----

function getTargetEditionDate(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  let y = Number(parts.year);
  let m = Number(parts.month);
  let d = Number(parts.day);
  const hour = Number(parts.hour);

  if (hour < 17) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 1);
    y = dt.getUTCFullYear();
    m = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
  }

  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

main().catch((err) => {
  console.error('Fatal error building edition:', err);
  process.exit(1);
});
