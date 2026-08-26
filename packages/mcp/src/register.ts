import type { z } from 'zod';
import { toolFailure, type ToolResult } from './errors.js';
import { TOOLS, type ToolContext, type ToolDefinition } from './tools.js';
import { DEFAULT_TOOL_SEPARATOR } from './config.js';

/**
 * Binding the tool surface to a server object, without importing one.
 *
 * `McpServerLike` is the exact slice of `McpServer` this package calls, written
 * out structurally. That is not indirection for its own sake: it is the list of
 * SDK API that has to be confirmed against the installed version, in one place,
 * and it lets every test drive the real registration path with a recording
 * double instead of a live transport.
 */

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
}

export interface ToolRegistration {
  title: string;
  description: string;
  /** A raw Zod shape, which is what the SDK projects into a JSON Schema. */
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
}

export interface McpServerLike {
  registerTool(
    name: string,
    config: ToolRegistration,
    handler: (args: unknown) => Promise<ToolResult>,
  ): unknown;
}

export interface RegisterOptions {
  /** Replaces the `.` in the canonical names. See `config.ts` for why. */
  toolSeparator?: string;
  tools?: readonly ToolDefinition[];
}

/** `forge.list_projects` under a client that will not take a dot. */
export function renderToolName(canonical: string, separator: string): string {
  return canonical.replace(/\./g, separator);
}

/**
 * Register every tool and return the names as they were registered.
 *
 * The wrapper catches everything. A tool that threw into the transport would
 * reach the model as a protocol failure — the client's own error text, not
 * ForgeBridge's — and the one sentence that says how to fix it would be lost.
 * `toolFailure` turns each refusal into a result the model can read and act on,
 * which is the whole point of mapping the protocol's error codes at all.
 */
export function registerForgeBridgeTools(
  server: McpServerLike,
  context: ToolContext,
  options: RegisterOptions = {},
): string[] {
  const separator = options.toolSeparator ?? DEFAULT_TOOL_SEPARATOR;
  const tools = options.tools ?? TOOLS;

  return tools.map((tool) => {
    const name = renderToolName(tool.name, separator);
    server.registerTool(
      name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
        annotations: {
          readOnlyHint: tool.readOnlyHint,
          destructiveHint: tool.destructiveHint,
          // Every tool reaches a Roblox place through a daemon this process
          // does not control. None of them is a closed-world computation.
          openWorldHint: true,
        },
      },
      async (args: unknown): Promise<ToolResult> => {
        try {
          return await tool.handler(args, context);
        } catch (error) {
          return toolFailure(error);
        }
      },
    );
    return name;
  });
}
