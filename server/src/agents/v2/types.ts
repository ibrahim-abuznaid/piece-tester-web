import type Anthropic from '@anthropic-ai/sdk';
import type { PieceMetadataFull } from '../../services/ap-client.js';
import type { TestPlanStep, TestPlanResult } from '../../services/ai-config-generator.js';
import type { MessagesClient } from '../../services/anthropic-client.js';
import type { ProbeResult } from '../../services/vendor-watch/types.js';

export { TestPlanStep, TestPlanResult };

// ── Agent roles ──

export type AgentRole = 'coordinator' | 'research' | 'planner' | 'verifier' | 'fixer' | 'watch_planner';

// ── Log entry (shared across all agents) ──

export interface AgentLogEntry {
  timestamp: number;
  type: 'thinking' | 'tool_call' | 'tool_result' | 'decision' | 'error' | 'done' | 'worker_spawn' | 'worker_complete' | 'phase' | 'mcp_call';
  role: AgentRole;
  message: string;
  detail?: string;
}

export type OnLogCallback = (log: AgentLogEntry) => void;

// ── Tool system ──

export interface ToolContext {
  pieceMeta: PieceMetadataFull;
  /** The target being planned. For trigger plans this holds the trigger name. */
  actionName: string;
  /** Whether the plan target is an action (default) or a trigger. */
  targetKind?: 'action' | 'trigger';
  /** For trigger plans: the trigger name under test (same value as actionName). */
  triggerName?: string;
  abortSignal?: AbortSignal;
  mcpEnabled?: boolean;
  createdFlowIds?: Set<string>;
  /** Vendor watch planner: every URL probe_source fetched this session (keyed by requested and final URL). */
  probedSources?: Map<string, ProbeResult>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Anthropic.Messages.Tool['input_schema'];
  handler: (input: Record<string, any>, ctx: ToolContext) => Promise<string>;
  /** Terminal tools only: return an error message to send back to the model instead of accepting the call. */
  validateTerminal?: (input: Record<string, any>, ctx: ToolContext) => string | null;
}

// ── Agent runner config ──

export interface AgentRunnerConfig {
  role: AgentRole;
  model: string;
  systemPrompt: string;
  initialMessages: Anthropic.Messages.MessageParam[];
  maxIterations: number;
  toolNames?: string[];
  abortSignal?: AbortSignal;
  onLog: OnLogCallback;
  /** Anthropic server tools (e.g. web_search) appended to the local tools. */
  serverTools?: Anthropic.Messages.ToolUnion[];
  /** Skip the Activepieces MCP tools even when a token is configured. */
  disableMcp?: boolean;
  /** Inject a client (tests). Defaults to the SDK client built from Settings. */
  client?: MessagesClient;
}

export interface AgentRunnerResult {
  /** The final tool-use output (parsed JSON or raw text) */
  output: unknown;
  /** Full conversation messages for the coordinator to inspect */
  messages: Anthropic.Messages.MessageParam[];
  /** Number of iterations used */
  iterations: number;
  /** Whether the agent terminated by calling a terminal tool */
  terminatedByTool: boolean;
}

// ── Research worker findings ──

export interface PropInfo {
  name: string;
  displayName: string;
  type: string;
  required: boolean;
  description?: string;
  defaultValue?: unknown;
  options?: { label: string; value: unknown }[];
  refreshers?: string[];
  isDynamic: boolean;
}

export interface ResearchFindings {
  targetEffect: 'read' | 'write' | 'unknown';
  sourceAnalysis: {
    actionFile: string | null;
    pieceSourceSummary: string;
    requiredProps: PropInfo[];
    optionalProps: PropInfo[];
    dropdownValues: Record<string, { label: string; value: unknown }[]>;
    outputShape: string;
    helperNotes: string;
  };
  discoveredResources: { type: string; id: string; name: string }[];
  recommendations: string;
}

// ── Verifier verdict ──

export type Verdict = 'PASS' | 'FAIL' | 'PARTIAL';

export interface VerificationIssue {
  severity: 'error' | 'warning';
  stepId?: string;
  field?: string;
  message: string;
}

export interface VerificationResult {
  verdict: Verdict;
  issues: VerificationIssue[];
  summary: string;
}

// ── Coordinator state ──

export interface CoordinatorPhase {
  name: 'research' | 'synthesis' | 'planning' | 'verification' | 'fixing' | 'complete';
  startedAt: number;
  completedAt?: number;
}

export interface CoordinatorState {
  phases: CoordinatorPhase[];
  researchFindings?: ResearchFindings;
  synthesizedSpec?: string;
  plan?: TestPlanResult;
  verification?: VerificationResult;
  fixAttempts: number;
  maxFixAttempts: number;
}
