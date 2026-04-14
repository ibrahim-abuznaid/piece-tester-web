/**
 * The coordinator doesn't use the Claude API directly -- it's an
 * orchestration layer in TypeScript that reads worker outputs and
 * writes precise specs. This file contains the synthesis logic.
 */

import type { PieceMetadataFull, PieceActionMeta } from '../../../services/ap-client.js';
import type { ResearchFindings } from '../types.js';
import { buildPieceContext, buildActionProperties, buildActionsList, buildLessonsBlock, buildMemoryBlock, RUNTIME_TOKENS_DOC, INPUT_MAPPING_DOC, NO_CUSTOM_HTTP_RULE } from './shared.js';

const AUTH_PROP_TYPES = ['OAUTH2', 'SECRET_TEXT', 'BASIC_AUTH', 'CUSTOM_AUTH'];
const SKIP_PROP_TYPES = ['MARKDOWN'];

/**
 * Parse the research worker's free-text output into structured findings.
 * Falls back gracefully if the format doesn't match exactly.
 */
export function parseResearchFindings(rawText: string): ResearchFindings {
  const findings: ResearchFindings = {
    targetEffect: 'unknown',
    sourceAnalysis: {
      actionFile: null,
      pieceSourceSummary: '',
      requiredProps: [],
      optionalProps: [],
      dropdownValues: {},
      outputShape: '',
      helperNotes: '',
    },
    discoveredResources: [],
    recommendations: '',
  };

  // Extract sections by headers
  const sourceMatch = rawText.match(/### SOURCE ANALYSIS\n([\s\S]*?)(?=### DISCOVERED RESOURCES|### RECOMMENDATIONS|$)/i);
  const resourcesMatch = rawText.match(/### DISCOVERED RESOURCES\n([\s\S]*?)(?=### RECOMMENDATIONS|$)/i);
  const recsMatch = rawText.match(/### RECOMMENDATIONS\n([\s\S]*?)$/i);

  if (sourceMatch) {
    findings.sourceAnalysis.pieceSourceSummary = sourceMatch[1].trim();

    const targetEffectMatch = sourceMatch[1].match(/Target effect:\s*(read|write|unknown)/i);
    if (targetEffectMatch) {
      findings.targetEffect = targetEffectMatch[1].toLowerCase() as 'read' | 'write' | 'unknown';
    }

    const actionFileMatch = sourceMatch[1].match(/Action file:\s*(.+)/i);
    if (actionFileMatch) findings.sourceAnalysis.actionFile = actionFileMatch[1].trim();

    const outputMatch = sourceMatch[1].match(/Output shape:\s*(.+(?:\n(?!- ).*)*)/i);
    if (outputMatch) findings.sourceAnalysis.outputShape = outputMatch[1].trim();

    const helperMatch = sourceMatch[1].match(/Helper notes:\s*(.+(?:\n(?!- ).*)*)/i);
    if (helperMatch) findings.sourceAnalysis.helperNotes = helperMatch[1].trim();
  }

  if (resourcesMatch) {
    const resourceLines = resourcesMatch[1].trim().split('\n');
    for (const line of resourceLines) {
      const match = line.match(/^-\s*(.+?):\s*(.+?)\s*--\s*(.+)/);
      if (match) {
        findings.discoveredResources.push({
          type: match[1].trim(),
          id: match[2].trim(),
          name: match[3].trim(),
        });
      }
    }
  }

  if (recsMatch) {
    findings.recommendations = recsMatch[1].trim();
  }

  return findings;
}

/**
 * Synthesize research findings into a precise spec for the planner worker.
 * This is the coordinator's most important job -- it must include specific
 * file paths, IDs, field names, and exactly what the planner should build.
 */
export function synthesizePlannerSpec(
  piece: PieceMetadataFull,
  actionName: string,
  findings: ResearchFindings,
  previousMemory?: string,
): string {
  const action = piece.actions[actionName];
  const lines: string[] = [];

  lines.push(`# Synthesized Specification for Test Plan`);
  lines.push('');
  lines.push(buildPieceContext(piece, actionName));
  lines.push('');

  const lessonsBlock = buildLessonsBlock(piece.name);
  if (lessonsBlock) lines.push(lessonsBlock);

  const memoryBlock = buildMemoryBlock(previousMemory);
  if (memoryBlock) lines.push(memoryBlock);

  // Synthesized research findings
  lines.push('');
  lines.push('## Research Findings (verified by research agent)');
  lines.push('');

  if (findings.sourceAnalysis.actionFile) {
    lines.push(`**Action source file:** ${findings.sourceAnalysis.actionFile}`);
  }

  if (findings.sourceAnalysis.pieceSourceSummary) {
    lines.push('');
    lines.push('### Source Code Analysis');
    lines.push(findings.sourceAnalysis.pieceSourceSummary);
  }

  if (findings.sourceAnalysis.outputShape) {
    lines.push('');
    lines.push(`**Expected output shape:** ${findings.sourceAnalysis.outputShape}`);
    lines.push('Use this to write correct inputMapping expressions.');
  }

  if (findings.discoveredResources.length > 0) {
    lines.push('');
    lines.push('### Available Resources (discovered via API)');
    for (const r of findings.discoveredResources) {
      lines.push(`- **${r.type}**: ID=${r.id} -- "${r.name}"`);
    }
    lines.push('');
    lines.push('Use these IDs directly in step inputs where appropriate.');
  }

  if (findings.recommendations) {
    lines.push('');
    lines.push('### Recommendations from Research');
    lines.push(findings.recommendations);
  }

  lines.push('');
  lines.push(`**Target action effect classification:** ${findings.targetEffect}`);

  // Action properties (authoritative, from metadata)
  lines.push('');
  if (action) lines.push(buildActionProperties(action, actionName));

  // Available actions for setup/cleanup
  lines.push('');
  lines.push(buildActionsList(piece));

  // Plan structure guidance
  lines.push('');
  lines.push(RUNTIME_TOKENS_DOC);
  lines.push('');
  lines.push(INPUT_MAPPING_DOC);
  lines.push('');
  lines.push(NO_CUSTOM_HTTP_RULE);

  lines.push('');
  lines.push('## Instructions');
  if (findings.targetEffect === 'read') {
    lines.push('Create a plan for a READ-ONLY target action.');
    lines.push('Prefer a single test step or read-only supporting steps.');
    lines.push('Do NOT add write-heavy setup steps such as send_*, create_*, update_*, delete_*, archive_*, move_*, reply_* unless the source code proves they are strictly required to test the target action.');
    lines.push('Prefer existing/discovered resources and stable references over creating new remote state.');
  } else {
    lines.push('Create a multi-step test plan. Setup steps create fresh resources each run (idempotent).');
    lines.push('The test step uses inputMapping to reference setup outputs.');
    lines.push('Use {{$uuid}} or {{$timestamp}} in resource names for uniqueness.');
  }
  lines.push('ALWAYS call set_test_plan when done.');

  return lines.join('\n');
}
