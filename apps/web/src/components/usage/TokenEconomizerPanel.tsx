import type { TokenEconomizerUsage } from "@t3tools/contracts";
import { formatCount, formatTokens } from "@t3tools/shared/usageFormat";
import { useId, useState } from "react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  economizerComparison,
  economizerModels,
  ECONOMIZER_MIN_SAMPLES,
} from "./tokenEconomizerComparison";
import { PROVIDER_PRESENTATION } from "./usageProviders";

function ComparisonBar({
  value,
  peak,
  period,
  empty,
}: {
  readonly value: number | null;
  readonly peak: number;
  readonly period: "Before" | "After";
  readonly empty: string;
}) {
  return (
    <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_5.5rem] items-center gap-3 text-xs">
      <span className="text-muted-foreground">{period}</span>
      <div className="relative h-2.5 min-w-0" aria-hidden>
        {value === null ? (
          <div className="absolute inset-0 rounded-xs border border-dashed border-border" />
        ) : (
          <div
            className="h-full rounded-xs"
            style={{
              width: `${peak > 0 ? Math.min(100, (value / peak) * 100) : 0}%`,
              backgroundColor:
                period === "After" ? PROVIDER_PRESENTATION.codex.color : "var(--muted-foreground)",
              opacity: period === "Before" ? 0.5 : 1,
            }}
          />
        )}
      </div>
      <span className="text-right text-muted-foreground tabular-nums">
        {value === null ? empty : formatTokens(value)}
      </span>
    </div>
  );
}

export function TokenEconomizerPanel({
  report,
  environmentLabel,
}: {
  readonly report: TokenEconomizerUsage;
  readonly environmentLabel?: string | undefined;
}) {
  const titleId = useId();
  const [preferredModel, setPreferredModel] = useState<string | null>(null);
  const models = economizerModels(report);
  const model =
    preferredModel !== null && models.includes(preferredModel) ? preferredModel : models[0];
  const rows = report.repositories.map((repo) => {
    const cohort = repo.cohorts.find((item) => item.model === model);
    return { repo, cohort, ...economizerComparison(cohort) };
  });
  const peak = Math.max(0, ...rows.flatMap((row) => [row.before ?? 0, row.after ?? 0]));
  const beforeCount = rows.reduce((n, row) => n + (row.cohort?.beforeSessions ?? 0), 0);
  const afterCount = rows.reduce((n, row) => n + (row.cohort?.afterSessions ?? 0), 0);
  const since = new Date(report.cutover).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-5 border-t pt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id={titleId} className="text-sm font-medium text-foreground">
            TokenEconomizer
          </h2>
          <p className="text-xs text-muted-foreground">
            Before &amp; after · since {since}
            {environmentLabel ? ` · ${environmentLabel}` : ""}
          </p>
        </div>
        {model === undefined ? null : (
          <Select value={model} onValueChange={setPreferredModel}>
            <SelectTrigger
              aria-label="TokenEconomizer model"
              size="compact"
              className="w-auto max-w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {models.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
        <h3 className="font-medium text-foreground">Average input tokens per session</h3>
        <span className="text-muted-foreground tabular-nums">
          {formatCount(beforeCount)} before · {formatCount(afterCount)} after
        </span>
      </div>

      {afterCount === 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground" role="status">
          Collecting data for this model. Start fresh Codex conversations in these repositories.
          Sessions appear after they end, or after ten quiet minutes and a subsequent session start.
        </p>
      ) : null}

      <div className="grid gap-x-10 gap-y-5 lg:grid-cols-2">
        {rows.map(({ repo, cohort, before, after, change }) => (
          <div key={repo.name} className="min-w-0 space-y-2">
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate font-medium text-foreground">
                {repo.name}
                {repo.enabled ? "" : " · paused"}
              </span>
              <span className="shrink-0 text-right text-muted-foreground tabular-nums">
                {change === null ? null : (
                  <span className="block">{`${Math.abs(change).toFixed(1)}% ${change < 0 ? "lower" : change > 0 ? "higher" : "change"}`}</span>
                )}
                <span className="block">
                  {cohort?.beforeSessions ?? 0} before · {cohort?.afterSessions ?? 0} after
                </span>
              </span>
            </div>
            <ComparisonBar period="Before" value={before} peak={peak} empty="No baseline" />
            <ComparisonBar period="After" value={after} peak={peak} empty="Pending" />
          </div>
        ))}
      </div>

      <div className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
        <p>
          Exact model match · cached input included · at least {ECONOMIZER_MIN_SAMPLES} sessions on
          each side before showing a change. This comparison uses all recorded sessions since
          installation, independently of the Usage period above.
        </p>
        <p>
          Optimizer overhead:{" "}
          <span className="tabular-nums">{formatTokens(report.overheadTokens)}</span> weighted
          tokens, tracked separately. Session size can vary; this graph does not establish financial
          ROI.
        </p>
        {report.excludedSessions > 0 ? (
          <p>{formatCount(report.excludedSessions)} mixed-model or incomplete sessions excluded.</p>
        ) : null}
        {report.warnings.map((warning) => (
          <p key={warning} role="status">
            {warning}
          </p>
        ))}
      </div>
    </section>
  );
}
