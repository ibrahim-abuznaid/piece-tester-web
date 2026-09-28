import { describe, it, expect } from 'vitest';
import { resolvePlanGenBudgetMs, DEFAULT_PLAN_GEN_BUDGET_MS } from './plan-budget.js';

describe('resolvePlanGenBudgetMs', () => {
  it('falls back to the default when unset', () => {
    expect(resolvePlanGenBudgetMs(undefined)).toBe(DEFAULT_PLAN_GEN_BUDGET_MS);
    expect(resolvePlanGenBudgetMs('')).toBe(DEFAULT_PLAN_GEN_BUDGET_MS);
  });

  it('falls back to the default for non-numeric or non-positive input', () => {
    expect(resolvePlanGenBudgetMs('abc')).toBe(DEFAULT_PLAN_GEN_BUDGET_MS);
    expect(resolvePlanGenBudgetMs('0')).toBe(DEFAULT_PLAN_GEN_BUDGET_MS);
    expect(resolvePlanGenBudgetMs('-5000')).toBe(DEFAULT_PLAN_GEN_BUDGET_MS);
  });

  it('honors a valid override in range', () => {
    expect(resolvePlanGenBudgetMs('120000')).toBe(120000);
  });

  it('clamps below the 1-minute floor', () => {
    expect(resolvePlanGenBudgetMs('5000')).toBe(60000);
  });

  it('clamps above the 10-minute ceiling (the request hard timeout)', () => {
    expect(resolvePlanGenBudgetMs('9999999')).toBe(600000);
  });

  it('default sits under the 600s request cap and over a healthy plan', () => {
    expect(DEFAULT_PLAN_GEN_BUDGET_MS).toBeLessThan(600000);
    expect(DEFAULT_PLAN_GEN_BUDGET_MS).toBeGreaterThan(60000);
  });
});
