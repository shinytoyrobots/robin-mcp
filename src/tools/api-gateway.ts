import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";

export function registerApiGatewayTools(server: McpServer): void {
  // GitHub search - only registered if token is configured
  if (config.githubToken) {
    server.tool(
      "github-search-repos",
      "Search GitHub repositories by query",
      {
        query: z.string().describe("Search query for GitHub repos"),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe("Max results to return (default 10)"),
      },
      async ({ query, limit }) => {
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`;
        const response = await fetch(url, {
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${config.githubToken}`,
            "User-Agent": "robin-mcp",
          },
        });

        if (!response.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `GitHub API error: ${response.status} ${response.statusText}`,
              },
            ],
            isError: true,
          };
        }

        const data = (await response.json()) as {
          total_count: number;
          items: Array<{
            full_name: string;
            description: string | null;
            html_url: string;
            stargazers_count: number;
            language: string | null;
            updated_at: string;
          }>;
        };

        const repos = data.items
          .map(
            (r) =>
              `${r.full_name} (${r.stargazers_count} stars)\n  ${r.description || "(no description)"}\n  ${r.html_url}\n  Language: ${r.language || "N/A"}`
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${data.total_count} repos (showing ${data.items.length}):\n\n${repos}`,
            },
          ],
        };
      }
    );
  }

  // Generic HTTP fetch - always available
  server.tool(
    "http-fetch",
    "Fetch content from any public URL or API endpoint",
    {
      url: z.string().url().describe("URL to fetch"),
      method: z
        .enum(["GET", "POST", "PUT", "DELETE", "PATCH"])
        .optional()
        .default("GET")
        .describe("HTTP method"),
      headers: z
        .record(z.string())
        .optional()
        .describe("Request headers as key-value pairs"),
      body: z
        .string()
        .optional()
        .describe("Request body (for POST/PUT/PATCH)"),
    },
    async ({ url, method, headers, body }) => {
      try {
        const response = await fetch(url, {
          method,
          headers: headers || {},
          body: body && method !== "GET" ? body : undefined,
        });

        const contentType = response.headers.get("content-type") || "";
        let text: string;

        if (contentType.includes("application/json")) {
          const json = await response.json();
          text = JSON.stringify(json, null, 2);
        } else {
          text = await response.text();
        }

        // Truncate very large responses
        if (text.length > 50000) {
          text = text.slice(0, 50000) + "\n\n... (truncated, response was " + text.length + " chars)";
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `HTTP ${response.status} ${response.statusText}\nContent-Type: ${contentType}\n\n${text}`,
            },
          ],
        };
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Fetch error: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
