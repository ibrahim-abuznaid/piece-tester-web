import type { CoverageRow, TestPlan } from './api';

export interface RunnableTarget {
  planId: number;
  targetAction: string;
  targetType: 'action' | 'trigger';
  runnable: boolean;
  reason?: string;
}
export interface PieceGroup {
  pieceName: string;
  displayName: string;
  logoUrl: string | null;
  connected: boolean;
  requiresAuth: boolean;
  targets: RunnableTarget[];
  runnable: boolean;
}

/**
 * Group approved plans by piece and mark which targets can run now.
 * Non-runnable when the piece requires a connection but has none, the plan is
 * stale (needs_regen=1), or the plan needs human input (it would pause mid-run
 * and wedge an unattended batch — run those interactively from the piece page).
 * Auth-less pieces (requires_auth=false, e.g. Delay/Crypto/helpers) run without
 * a connection. Connected-but-broken-upstream is not detectable cheaply here;
 * such runs are gated server-side and recorded as `blocked`.
 */
export function buildPieceGroups(coverage: CoverageRow[], plans: TestPlan[]): PieceGroup[] {
  const covByPiece = new Map(coverage.map((c) => [c.piece_name, c]));
  const byPiece = new Map<string, TestPlan[]>();
  for (const p of plans) {
    if (p.status !== 'approved') continue;
    if (!byPiece.has(p.piece_name)) byPiece.set(p.piece_name, []);
    byPiece.get(p.piece_name)!.push(p);
  }

  const groups: PieceGroup[] = [];
  for (const [pieceName, piecePlans] of byPiece) {
    const c = covByPiece.get(pieceName);
    const connected = c?.connected ?? false;
    const requiresAuth = c?.requires_auth ?? true;
    const missingConn = requiresAuth && !connected;
    const targets: RunnableTarget[] = piecePlans
      .map((p) => {
        const stale = p.needs_regen === 1;
        const needsHuman = p.automation_status === 'requires_human';
        const reason = missingConn ? 'No active connection — connect first'
          : stale ? 'Plan is stale — regenerate first'
          : needsHuman ? 'Needs human input — run it from the piece page'
          : undefined;
        return {
          planId: p.id,
          targetAction: p.target_action,
          targetType: (p.target_type ?? 'action') as 'action' | 'trigger',
          runnable: !missingConn && !stale && !needsHuman,
          reason,
        };
      })
      .sort((a, b) => a.targetAction.localeCompare(b.targetAction));
    groups.push({
      pieceName,
      displayName: c?.display_name ?? pieceName,
      logoUrl: c?.logo_url ?? null,
      connected,
      requiresAuth,
      targets,
      runnable: targets.some((t) => t.runnable),
    });
  }
  return groups.sort((a, b) => a.displayName.localeCompare(b.displayName));
}
