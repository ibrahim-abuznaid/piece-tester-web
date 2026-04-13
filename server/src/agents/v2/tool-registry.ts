import type Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition, ToolContext } from './types.js';

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Return Anthropic tool schemas, optionally filtered by name list. */
  getTools(filter?: string[]): Anthropic.Messages.Tool[] {
    const entries = filter
      ? filter.map(n => this.tools.get(n)).filter(Boolean) as ToolDefinition[]
      : [...this.tools.values()];

    return entries.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }

  /** Execute a tool by name. Throws if unknown. */
  async execute(toolName: string, input: Record<string, any>, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: "${toolName}". Available: ${[...this.tools.keys()].join(', ')}`);
    }
    return tool.handler(input, ctx);
  }

  /** List all registered tool names. */
  listNames(): string[] {
    return [...this.tools.keys()];
  }

  /** Clone the registry (useful for giving workers a filtered copy). */
  subset(names: string[]): ToolRegistry {
    const sub = new ToolRegistry();
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) sub.tools.set(name, tool);
    }
    return sub;
  }
}
