import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { errorResult, textResult } from '../content.js';
import type { Context } from '../context.js';

// Every tool declares what it does to the world through MCP annotations, and destructive tools can
// ask for the person's OK first. Calls run one at a time.

export interface ToolSpec<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Only reads: changes nothing on the server, in the world or on disk. */
  readOnly: boolean;
  /** May overwrite or remove something that was there before. */
  destructive: boolean;
  /** Calling again with the same input has no further effect. */
  idempotent: boolean;
  /** Talks to something beyond this computer (the setup downloads). */
  openWorld?: boolean;
  /** When the person's settings ask for confirmation, says what needs their OK, or null when nothing does. */
  needsOk?: (args: z.output<z.ZodObject<S>>, ctx: Context) => string | null;
  run: (args: z.output<z.ZodObject<S>>, ctx: Context) => Promise<unknown>;
}

export function tool<S extends z.ZodRawShape>(spec: ToolSpec<S>): ToolSpec {
  return spec as unknown as ToolSpec;
}

export class NeedsOkError extends Error {}

export async function runTool(ctx: Context, spec: ToolSpec, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    return await ctx.serial(async () => {
      if (spec.needsOk && ctx.config.confirmDestructive && args.confirm !== true) {
        const what = spec.needsOk(args as never, ctx);
        if (what) {
          throw new NeedsOkError(`Needs the person's OK first: ${what}. Tell them what will change, and if they agree call ${spec.name} again with confirm: true. (confirmDestructive is on in the config.)`);
        }
      }
      return textResult(await spec.run(args as never, ctx));
    });
  } catch (e) {
    return errorResult(e);
  }
}

export function annotations(spec: ToolSpec) {
  return {
    title: spec.title,
    readOnlyHint: spec.readOnly,
    destructiveHint: spec.readOnly ? false : spec.destructive,
    idempotentHint: spec.readOnly ? true : spec.idempotent,
    openWorldHint: spec.openWorld ?? false,
  };
}

export function registerTools(server: McpServer, ctx: Context, specs: ToolSpec[]): void {
  for (const spec of specs) {
    const config = { title: spec.title, description: spec.description, inputSchema: spec.input, annotations: annotations(spec) };
    server.registerTool(spec.name, config, (args: Record<string, unknown>) => runTool(ctx, spec, args));
  }
}
