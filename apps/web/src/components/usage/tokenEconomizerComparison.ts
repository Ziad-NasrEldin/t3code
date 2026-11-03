import type { TokenEconomizerCohort, TokenEconomizerUsage } from "@t3tools/contracts";

export const ECONOMIZER_MIN_SAMPLES = 5;

export function economizerModels(report: TokenEconomizerUsage): readonly string[] {
  const counts = new Map<string, { before: number; after: number }>();
  for (const repo of report.repositories) {
    for (const cohort of repo.cohorts) {
      const prior = counts.get(cohort.model) ?? { before: 0, after: 0 };
      counts.set(cohort.model, {
        before: prior.before + cohort.beforeSessions,
        after: prior.after + cohort.afterSessions,
      });
    }
  }
  return [...counts]
    .sort(([a, x], [b, y]) => y.after - x.after || y.before - x.before || a.localeCompare(b))
    .map(([model]) => model);
}

export function economizerComparison(cohort: TokenEconomizerCohort | undefined) {
  const before =
    cohort && cohort.beforeSessions > 0 ? cohort.beforeInputTokens / cohort.beforeSessions : null;
  const after =
    cohort && cohort.afterSessions > 0 ? cohort.afterInputTokens / cohort.afterSessions : null;
  const change =
    before !== null &&
    before > 0 &&
    after !== null &&
    cohort !== undefined &&
    cohort.beforeSessions >= ECONOMIZER_MIN_SAMPLES &&
    cohort.afterSessions >= ECONOMIZER_MIN_SAMPLES
      ? (after / before - 1) * 100
      : null;
  return { before, after, change };
}
