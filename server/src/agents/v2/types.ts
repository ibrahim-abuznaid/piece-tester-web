import type Anthropic from '@anthropic-ai/sdk';
import type { PieceMetadataFull } from '../../services/ap-client.js';
import type { TestPlanStep, TestPlanResult } from '../../services/ai-config-generator.js';

export { TestPlanStep, TestPlanResult };

// ── Agent roles ──

export type AgentRole = 'coordinator' | 'research' | 'planner' | 'verifier' | 'fixer';

// ── Log entry (shared across all agents) ──

export interface AgentLogEntry {
  timestamp: number;
  type: 'thinking' | 'tool_call' | 'tool_result' | 'decision' | 'error' | 'done' | 'worker_spawn' | 'worker_complete' | 'phase';
  role: AgentRole;
  message: string;
  detail?: string;
}

export type OnLogCallback = (log: AgentLogEntry) => void;

// ── Tool system ──

export interface ToolContext {
  pieceMeta: PieceMetadataFull;
  actionName: string;
  abortSignal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Anthropic.Messages.Tool['input_schema'];
  handler: (input: Record<string, any>, ctx: ToolContext) => Promise<string>;
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
