import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { fetchWebsiteContent, fetchRssFeed, fetchSubstackListing } from "../lib/fetch-website.js";
import { getLinkedInResource } from "../lib/fetch-linkedin.js";

const WRITINGS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cachedFetch(fetcher: () => Promise<string>, ttlMs = WRITINGS_CACHE_TTL_MS) {
  let cached: string | null = null;
  let cachedAt = 0;
  return async (): Promise<string> => {
    const now = Date.now();
    if (!cached || now - cachedAt > ttlMs) {
      cached = await fetcher();
      cachedAt = now;
    }
    return cached;
  };
}

export function registerWritingsResources(server: McpServer): void {
  const getWebsite = cachedFetch(() => fetchWebsiteContent(config.websiteUrl));
  const getBlogPosts = cachedFetch(() => fetchRssFeed(config.rssFeedUrl));
  const getShinyToyRobots = cachedFetch(() =>
    fetchSubstackListing("https://www.robin-cannon.com/s/shiny-toy-robots", "Shiny Toy Robots")
  );
  const getAlternateFrequencies = cachedFetch(() =>
    fetchSubstackListing("https://www.robin-cannon.com/p/alternate-frequencies", "Alternate Frequencies")
  );

  server.resource(
    "personal-website",
    "robin://writings/website",
    { description: "Content from robin-cannon.com — Robin Cannon's personal website on Substack" },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/plain",
          text: await getWebsite(),
        },
      ],
    })
  );

  server.resource(
    "blog-posts",
    "robin://writings/blog-posts",
    { description: "Blog posts from robin-cannon.com RSS feed" },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/plain",
          text: await getBlogPosts(),
        },
      ],
    })
  );

  server.resource(
    "shiny-toy-robots",
    "robin://writings/shiny-toy-robots",
    { description: "Posts from the 'Shiny Toy Robots' section — creative and experimental writing" },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/plain",
          text: await getShinyToyRobots(),
        },
      ],
    })
  );

  server.resource(
    "alternate-frequencies",
    "robin://writings/alternate-frequencies",
    { description: "Posts from 'Alternate Frequencies' — fiction and narrative explorations" },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/plain",
          text: await getAlternateFrequencies(),
        },
      ],
    })
  );

  server.resource(
    "linkedin-profile",
    "robin://writings/linkedin",
    { description: "LinkedIn profile link" },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/plain",
          text: getLinkedInResource(config.linkedinUrl),
        },
      ],
    })
  );

}
