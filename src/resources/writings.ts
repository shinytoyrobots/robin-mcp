import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { fetchWebsiteContent, fetchRssFeed, fetchSubstackListing } from "../lib/fetch-website.js";
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
    "shiny-toy-robots",
    "robin://writings/shiny-toy-robots",
    { description: "Posts from the 'Shiny Toy Robots' section — creative and experimental writing" },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/plain",
          text: await fetchSubstackListing(
            "https://www.robin-cannon.com/s/shiny-toy-robots",
            "Shiny Toy Robots"
          ),
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
          text: await fetchSubstackListing(
            "https://www.robin-cannon.com/p/alternate-frequencies",
            "Alternate Frequencies"
          ),
        },
      ],
    })
  );

  server.resource(
    "static-drift-posts",
    "robin://writings/static-drift",
    { description: "Posts tagged 'staticdrift' — fiction set in the Static Drift universe" },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/plain",
          text: await fetchSubstackListing(
            "https://www.robin-cannon.com/t/staticdrift",
            "Static Drift (tagged posts)"
          ),
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
