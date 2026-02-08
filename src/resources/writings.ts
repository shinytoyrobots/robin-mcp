import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { fetchWebsiteContent, fetchRssFeed } from "../lib/fetch-website.js";
import { getLinkedInResource } from "../lib/fetch-linkedin.js";

export function registerWritingsResources(server: McpServer): void {
  server.resource(
    "personal-website",
    "robin://writings/website",
    { description: "Content from personal website" },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/plain",
          text: await fetchWebsiteContent(config.websiteUrl),
        },
      ],
    })
  );

  server.resource(
    "blog-posts",
    "robin://writings/blog-posts",
    { description: "Blog posts from RSS feed" },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/plain",
          text: await fetchRssFeed(config.rssFeedUrl),
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
