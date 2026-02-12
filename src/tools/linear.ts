import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { getLinearAccessToken, clearLinearToken, getLinearOAuthStatus } from "../lib/linear-oauth.js";

interface LinearResponse<T> {
  data: T;
  errors?: Array<{ message: string }>;
}

async function linearQuery<T>(query: string, variables?: Record<string, unknown>): Promise<LinearResponse<T>> {
  const token = await getLinearAccessToken();
  if (!token) {
    throw new Error("Linear not connected. Visit /auth/linear to authorize.");
  }

  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (response.status === 401) {
    clearLinearToken();
    throw new Error("Linear token expired or revoked. Visit /auth/linear to re-authorize.");
  }

  if (!response.ok) {
    throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<LinearResponse<T>>;
}

function formatError(errors: Array<{ message: string }> | undefined): string | null {
  if (!errors || errors.length === 0) return null;
  return errors.map((e) => e.message).join(", ");
}

export function registerLinearTools(server: McpServer, readOnly = false): void {
  const hasOAuth = getLinearOAuthStatus().connected;
  const hasClientCredentials = !!(config.linearClientId && config.linearClientSecret);
  if (!hasOAuth && !hasClientCredentials) return;

  // Resource: teams overview
  server.resource(
    "linear-teams",
    "robin://linear/teams",
    { description: "Linear teams and their keys" },
    async (uri) => {
      const result = await linearQuery<{
        teams: { nodes: Array<{ name: string; key: string; id: string }> };
      }>("{ teams { nodes { name key id } } }");

      const teams = result.data.teams.nodes
        .map((t) => `${t.key} - ${t.name}`)
        .join("\n");

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "text/plain",
            text: `# Linear Teams\n\n${teams}`,
          },
        ],
      };
    }
  );

  // Tool: search issues
  server.tool(
    "linear-search-issues",
    "Search Linear issues by query text",
    {
      query: z.string().describe("Search query"),
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
      offset: z.number().optional().default(0).describe("Number of results to skip for pagination"),
    },
    async ({ query, limit, offset }) => {
      const fetchCount = offset + limit;
      const result = await linearQuery<{
        searchIssues: {
          nodes: Array<{
            identifier: string;
            title: string;
            state: { name: string };
            assignee: { name: string } | null;
            priority: number;
            team: { key: string };
            url: string;
          }>;
        };
      }>(
        `query($query: String!, $fetchCount: Int!) {
          searchIssues(query: $query, first: $fetchCount) {
            nodes {
              identifier title url priority
              state { name }
              assignee { name }
              team { key }
            }
          }
        }`,
        { query, fetchCount }
      );

      const err = formatError(result.errors);
      if (err) return { content: [{ type: "text" as const, text: `Linear error: ${err}` }], isError: true };

      const allIssues = result.data.searchIssues.nodes;
      const issues = allIssues.slice(offset, offset + limit);
      if (issues.length === 0) {
        return { content: [{ type: "text" as const, text: "No issues found." }] };
      }

      const lines = issues.map(
        (i) =>
          `${i.identifier}: ${i.title}\n  Status: ${i.state.name} | Assignee: ${i.assignee?.name || "Unassigned"} | Priority: ${priorityLabel(i.priority)}\n  ${i.url}`
      );

      const hasMore = allIssues.length > offset + limit;
      const showing = offset > 0 || hasMore
        ? `Showing ${offset + 1}–${offset + issues.length}${hasMore ? "+" : ""} issues`
        : `Found ${issues.length} issue(s)`;

      return {
        content: [{ type: "text" as const, text: `${showing}:\n\n${lines.join("\n\n")}` }],
      };
    }
  );

  // Tool: get issue detail
  server.tool(
    "linear-get-issue",
    "Get full details of a Linear issue by identifier (e.g. KSP-123)",
    {
      identifier: z.string().describe("Issue identifier, e.g. KSP-123"),
    },
    async ({ identifier }) => {
      const [teamKey, numStr] = identifier.split("-");
      const number = parseInt(numStr, 10);

      const result = await linearQuery<{
        issues: {
          nodes: Array<{
            identifier: string;
            title: string;
            description: string | null;
            state: { name: string };
            assignee: { name: string } | null;
            priority: number;
            labels: { nodes: Array<{ name: string }> };
            team: { name: string; key: string };
            project: { name: string } | null;
            createdAt: string;
            updatedAt: string;
            url: string;
            comments: { nodes: Array<{ body: string; user: { name: string }; createdAt: string }> };
          }>;
        };
      }>(
        `query($teamKey: String!, $number: Float!) {
          issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }) {
            nodes {
              identifier title description url priority createdAt updatedAt
              state { name }
              assignee { name }
              labels { nodes { name } }
              team { name key }
              project { name }
              comments { nodes { body createdAt user { name } } }
            }
          }
        }`,
        { teamKey, number }
      );

      const err = formatError(result.errors);
      if (err) return { content: [{ type: "text" as const, text: `Linear error: ${err}` }], isError: true };

      const issues = result.data.issues.nodes;
      if (issues.length === 0) {
        return { content: [{ type: "text" as const, text: `Issue ${identifier} not found.` }], isError: true };
      }

      const i = issues[0];
      const labels = i.labels.nodes.map((l) => l.name).join(", ") || "none";
      let text = `# ${i.identifier}: ${i.title}\n\n`;
      text += `Team: ${i.team.name}\nStatus: ${i.state.name}\nPriority: ${priorityLabel(i.priority)}\n`;
      text += `Assignee: ${i.assignee?.name || "Unassigned"}\nLabels: ${labels}\n`;
      if (i.project) text += `Project: ${i.project.name}\n`;
      text += `Created: ${i.createdAt}\nUpdated: ${i.updatedAt}\n`;
      text += `URL: ${i.url}\n`;
      if (i.description) text += `\n---\n\n${i.description}`;

      if (i.comments.nodes.length > 0) {
        text += `\n\n---\n\n## Comments (${i.comments.nodes.length})\n`;
        for (const c of i.comments.nodes) {
          text += `\n**${c.user.name}** (${c.createdAt}):\n${c.body}\n`;
        }
      }

      return { content: [{ type: "text" as const, text }] };
    }
  );

  // Tool: list my assigned issues
  server.tool(
    "linear-my-issues",
    "List issues assigned to you, optionally filtered by team",
    {
      team: z.string().optional().describe("Team key to filter by, e.g. KSP"),
      status: z.string().optional().describe("Filter by status name, e.g. 'In Progress'"),
      limit: z.number().optional().default(25).describe("Max results (default 25)"),
      offset: z.number().optional().default(0).describe("Number of results to skip for pagination"),
    },
    async ({ team, status, limit, offset }) => {
      const fetchCount = offset + limit;
      const filters: string[] = ["assignee: { isMe: { eq: true } }"];
      if (team) filters.push(`team: { key: { eq: "${team}" } }`);
      if (status) filters.push(`state: { name: { eq: "${status}" } }`);

      const result = await linearQuery<{
        issues: {
          nodes: Array<{
            identifier: string;
            title: string;
            state: { name: string };
            priority: number;
            team: { key: string };
            url: string;
            updatedAt: string;
          }>;
        };
      }>(
        `query($fetchCount: Int!) {
          issues(filter: { ${filters.join(", ")} }, first: $fetchCount, orderBy: updatedAt) {
            nodes {
              identifier title url priority updatedAt
              state { name }
              team { key }
            }
          }
        }`,
        { fetchCount }
      );

      const err = formatError(result.errors);
      if (err) return { content: [{ type: "text" as const, text: `Linear error: ${err}` }], isError: true };

      const allIssues = result.data.issues.nodes;
      const issues = allIssues.slice(offset, offset + limit);
      if (issues.length === 0) {
        return { content: [{ type: "text" as const, text: "No assigned issues found." }] };
      }

      const lines = issues.map(
        (i) => `${i.identifier}: ${i.title}\n  ${i.state.name} | P${i.priority} | Updated: ${i.updatedAt.slice(0, 10)}`
      );

      const hasMore = allIssues.length > offset + limit;
      const showing = offset > 0 || hasMore
        ? `Showing ${offset + 1}–${offset + issues.length}${hasMore ? "+" : ""} of your issues`
        : `Your issues (${issues.length})`;

      return {
        content: [{ type: "text" as const, text: `${showing}:\n\n${lines.join("\n\n")}` }],
      };
    }
  );

  // Tool: create an issue
  if (!readOnly) server.tool(
    "linear-create-issue",
    "Create a new Linear issue",
    {
      teamKey: z.string().describe("Team key, e.g. KSP"),
      title: z.string().describe("Issue title"),
      description: z.string().optional().describe("Issue description (markdown)"),
      priority: z.number().optional().describe("Priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low"),
    },
    async ({ teamKey, title, description, priority }) => {
      // First resolve team ID
      const teamResult = await linearQuery<{
        teams: { nodes: Array<{ id: string; key: string }> };
      }>(
        `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }`,
        { key: teamKey }
      );

      const teams = teamResult.data.teams.nodes;
      if (teams.length === 0) {
        return { content: [{ type: "text" as const, text: `Team ${teamKey} not found.` }], isError: true };
      }

      const input: Record<string, unknown> = {
        teamId: teams[0].id,
        title,
      };
      if (description) input.description = description;
      if (priority !== undefined) input.priority = priority;

      const result = await linearQuery<{
        issueCreate: {
          success: boolean;
          issue: { identifier: string; title: string; url: string };
        };
      }>(
        `mutation($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { identifier title url }
          }
        }`,
        { input }
      );

      const err = formatError(result.errors);
      if (err) return { content: [{ type: "text" as const, text: `Linear error: ${err}` }], isError: true };

      const issue = result.data.issueCreate.issue;
      return {
        content: [{ type: "text" as const, text: `Created: ${issue.identifier} - ${issue.title}\n${issue.url}` }],
      };
    }
  );
}

function priorityLabel(p: number): string {
  return ["None", "Urgent", "High", "Medium", "Low"][p] || `P${p}`;
}
