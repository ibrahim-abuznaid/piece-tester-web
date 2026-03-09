/**
 * Lesson Extractor — analyzes a (failed plan → fixed plan) diff and uses Claude
 * to distill 2–5 concise, reusable lessons about the specific piece.
 * Lessons are stored in the DB and injected into future AI prompts for that piece.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSettings, addLesson, getLessonsForPiece } from '../db/queries.js';
import type { TestPlanStep } from './ai-config-generator.js';

const EXTRACTOR_SYSTEM = `You are an expert at analyzing why Activepieces integration test plans fail and what was done to fix them.

Your job is to extract concise, actionable lessons that will help future AI agents avoid the same mistakes when creating or fixing test plans for the SAME piece.

Rules:
- Each lesson must be 1-2 sentences max, very specific, and immediately actionable
- Focus on structural patterns: which action to use for what, where to find IDs, correct inputMapping paths, what NOT to do
- Do NOT write vague lessons like "make sure input is correct" — be specific about field names, action names, and data paths
- Do NOT repeat existing lessons (they will be provided)
- Output ONLY a JSON array of lesson strings (no markdown, no explanation)
- Output between 1 and 5 lessons. If there is nothing new to learn, output []`;

export async function extractAndStoreLessons(
  pieceName: string,
  pieceDisplayName: string,
  oldSteps: TestPlanStep[],
  failedResults: { stepId: string; status: string; output: unknown; error: string | null }[],
  newSteps: TestPlanStep[],
): Promise<string[]> {
  const settings = getSettings();
  if (!settings.anthropic_api_key) return [];

  const existingLessons = getLessonsForPiece(pieceName).map(l => l.lesson);

  const prompt = buildExtractorPrompt(pieceDisplayName, oldSteps, failedResults, newSteps, existingLessons);

  try {
    const client = new Anthropic({ apiKey: settings.anthropic_api_key });
    const model = settings.ai_model || 'claude-sonnet-4-6';

    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: EXTRACTOR_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content.find(b => b.type === 'text')?.text?.trim() || '[]';
    // Extract JSON array from response (Claude sometimes wraps in ```json)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const lessons: string[] = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(lessons) || lessons.length === 0) return [];

    // Store each lesson
    for (const lesson of lessons) {
      if (typeof lesson === 'string' && lesson.trim()) {
        addLesson(pieceName, lesson.trim(), 'fix');
        console.log(`[lessons] Stored lesson for ${pieceName}: ${lesson.slice(0, 100)}`);
      }
    }

    return lessons;
  } catch (err: any) {
    console.warn(`[lessons] Failed to extract lessons for ${pieceName}:`, err.message);
    return [];
  }
}

function buildExtractorPrompt(
  pieceDisplayName: string,
  oldSteps: TestPlanStep[],
  failedResults: { stepId: string; status: string; output: unknown; error: string | null }[],
  newSteps: TestPlanStep[],
  existingLessons: string[],
): string {
  const lines: string[] = [];

  lines.push(`## Piece: ${pieceDisplayName}`);

  lines.push('\n## FAILED PLAN (what was tried):');
  for (const step of oldSteps) {
    lines.push(`\n### Step: ${step.id} — "${step.label}" (${step.type})`);
    lines.push(`Action: ${step.actionName}`);
    lines.push(`Input: ${JSON.stringify(step.input, null, 2).slice(0, 500)}`);
    if (step.inputMapping && Object.keys(step.inputMapping).length > 0) {
      lines.push(`InputMapping: ${JSON.stringify(step.inputMapping)}`);
    }
    const result = failedResults.find(r => r.stepId === step.id);
    if (result) {
      lines.push(`Result: ${result.status}`);
      if (result.error) lines.push(`Error: ${result.error.slice(0, 300)}`);
      if (result.output) lines.push(`Output (first 300 chars): ${JSON.stringify(result.output).slice(0, 300)}`);
    }
  }

  lines.push('\n## FIXED PLAN (what worked):');
  for (const step of newSteps) {
    lines.push(`\n### Step: ${step.id} — "${step.label}" (${step.type})`);
    lines.push(`Action: ${step.actionName}`);
    lines.push(`Input: ${JSON.stringify(step.input, null, 2).slice(0, 500)}`);
    if (step.inputMapping && Object.keys(step.inputMapping).length > 0) {
      lines.push(`InputMapping: ${JSON.stringify(step.inputMapping)}`);
    }
  }

  if (existingLessons.length > 0) {
    lines.push('\n## EXISTING LESSONS (do NOT repeat these):');
    for (const l of existingLessons) {
      lines.push(`- ${l}`);
    }
  }

  lines.push('\n## Your task:');
  lines.push('Analyze the diff between the failed and fixed plan. What did the AI get wrong and what was the correct approach?');
  lines.push('Output a JSON array of 1–5 new, specific lessons. Each lesson should help a future AI agent immediately avoid the same mistake.');

  return lines.join('\n');
}

/**
 * Format stored lessons for injection into an AI prompt.
 * Returns empty string if no lessons exist.
 */
export function formatLessonsForPrompt(pieceName: string): string {
  const lessons = getLessonsForPiece(pieceName);
  if (lessons.length === 0) return '';

  const lines = [
    `\n## ⚠️ LEARNED LESSONS FOR ${pieceName.toUpperCase()} (from past failures — follow these exactly):`,
  ];
  for (let i = 0; i < lessons.length; i++) {
    lines.push(`${i + 1}. ${lessons[i].lesson}`);
  }
  lines.push('\nApply these lessons when designing the plan. Do not repeat known mistakes.\n');
  return lines.join('\n');
}
