import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logToolCall, resolveSourceId } from "./tracker.js";

interface InstrumentOptions {
  authLevel: "full" | "readonly" | "open";
}

export function instrumentServer(
  server: McpServer,
  options: InstrumentOptions,
): void {
  const originalTool = server.tool.bind(server);

  // Replace server.tool with an instrumented version.
  // The project uses the 4-arg form: tool(name, description, schema, callback)
  // but we handle all overloads by detecting the callback (last function arg).
  server.tool = function (...args: unknown[]) {
    const lastIdx = args.length - 1;
    if (typeof args[lastIdx] !== "function") {
      // No callback to wrap — pass through unchanged
      return (originalTool as (...a: unknown[]) => unknown)(...args);
    }

    const toolName = args[0] as string;
    const originalCallback = args[lastIdx] as (
      ...cbArgs: unknown[]
    ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

    const wrappedCallback = async (...cbArgs: unknown[]) => {
      const start = Date.now();
      let status: "success" | "error" = "success";
      let errorMessage: string | undefined;
      let result: { content: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;

      // Compute request size from the first arg (the parsed params object)
      const requestSize = cbArgs[0] ? JSON.stringify(cbArgs[0]).length : 0;

      try {
        result = await originalCallback(...cbArgs);
        if (result.isError) {
          status = "error";
          const firstText = result.content.find((c) => c.type === "text");
          errorMessage = firstText?.text?.slice(0, 500);
        }
      } catch (err) {
        status = "error";
        errorMessage =
          err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
        throw err;
      } finally {
        const durationMs = Date.now() - start;
        const responseSize = result
          ? (result.content ?? [])
              .filter((c) => c.type === "text")
              .reduce((sum, c) => sum + (c.text?.length ?? 0), 0)
          : 0;

        try {
          logToolCall({
            toolName,
            sourceId: resolveSourceId(toolName),
            authLevel: options.authLevel,
            status,
            durationMs,
            requestSize,
            responseSize,
            errorMessage,
          });
        } catch {
          // Never let analytics logging break a tool call
        }
      }

      return result!;
    };

    const newArgs = [...args];
    newArgs[lastIdx] = wrappedCallback;
    return (originalTool as (...a: unknown[]) => unknown)(...newArgs);
  } as typeof server.tool;
}
