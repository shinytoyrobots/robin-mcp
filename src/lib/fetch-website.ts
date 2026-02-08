/**
 * Fetch and parse website content or RSS feed.
 * Returns plain text suitable for LLM consumption.
 */
export async function fetchWebsiteContent(url: string): Promise<string> {
  if (!url) {
    return "No website URL configured. Set WEBSITE_URL in .env";
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return `Failed to fetch ${url}: ${response.status} ${response.statusText}`;
    }

    let text = await response.text();

    // Strip HTML tags for a cleaner text representation
    text = stripHtml(text);

    // Truncate if very large
    if (text.length > 100000) {
      text =
        text.slice(0, 100000) +
        "\n\n... (truncated)";
    }

    return text;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error fetching ${url}: ${message}`;
  }
}

export async function fetchRssFeed(url: string): Promise<string> {
  if (!url) {
    return "No RSS feed URL configured. Set RSS_FEED_URL in .env";
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return `Failed to fetch RSS feed ${url}: ${response.status} ${response.statusText}`;
    }

    const xml = await response.text();

    // Extract items from RSS/Atom feed using simple regex parsing
    const items: string[] = [];
    const itemRegex = /<item[\s>][\s\S]*?<\/item>/gi;
    const entryRegex = /<entry[\s>][\s\S]*?<\/entry>/gi;
    const matches = xml.match(itemRegex) || xml.match(entryRegex) || [];

    for (const item of matches) {
      const title = extractTag(item, "title");
      const link =
        extractTag(item, "link") || extractAttr(item, "link", "href");
      const pubDate =
        extractTag(item, "pubDate") ||
        extractTag(item, "published") ||
        extractTag(item, "updated");
      const description =
        extractTag(item, "description") ||
        extractTag(item, "summary") ||
        extractTag(item, "content");

      let entry = `## ${title || "(untitled)"}`;
      if (pubDate) entry += `\nDate: ${pubDate}`;
      if (link) entry += `\nLink: ${link}`;
      if (description) {
        const clean = stripHtml(description).slice(0, 500);
        entry += `\n${clean}`;
      }
      items.push(entry);
    }

    if (items.length === 0) {
      return `RSS feed at ${url} returned no items. Raw content length: ${xml.length} chars.`;
    }

    return `# Blog Posts (${items.length} entries)\n\n${items.join("\n\n---\n\n")}`;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error fetching RSS feed ${url}: ${message}`;
  }
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(
    new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i")
  ) ||
    xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1].trim() : "";
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const match = xml.match(
    new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, "i")
  );
  return match ? match[1] : "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
