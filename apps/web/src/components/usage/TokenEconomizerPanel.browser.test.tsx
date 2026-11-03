import type { TokenEconomizerUsage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { TokenEconomizerPanel } from "./TokenEconomizerPanel";

const report: TokenEconomizerUsage = {
  installationId: "fixture",
  cutover: "2026-11-03T00:00:00.000Z",
  readAt: "2026-11-04T00:00:00.000Z",
  overheadTokens: 12,
  excludedSessions: 0,
  warnings: [],
  repositories: [
    {
      name: "Example",
      enabled: true,
      foldedSessions: 5,
      cohorts: [
        {
          model: "model-a",
          beforeSessions: 5,
          afterSessions: 5,
          beforeInputTokens: 5000,
          afterInputTokens: 4000,
        },
        {
          model: "model-b",
          beforeSessions: 5,
          afterSessions: 5,
          beforeInputTokens: 1000,
          afterInputTokens: 2000,
        },
      ],
    },
  ],
};

describe("TokenEconomizer panel", () => {
  it("keeps an absent after sample pending rather than showing a saving", async () => {
    const cohort = report.repositories[0]!.cohorts[0]!;
    await using screen = await render(
      <TokenEconomizerPanel
        report={{
          ...report,
          repositories: [
            {
              name: "Example",
              enabled: true,
              foldedSessions: 0,
              cohorts: [{ ...cohort, afterSessions: 0, afterInputTokens: 0 }],
            },
          ],
        }}
      />,
    );
    await expect.element(screen.getByText("Pending", { exact: true })).toBeVisible();
    await expect.element(screen.getByText(/Collecting data/)).toBeVisible();
    await expect.element(screen.getByText(/100.0% lower/)).not.toBeInTheDocument();
  });

  it("changes exact-model cohorts and keeps increased input usage visible", async () => {
    await using screen = await render(<TokenEconomizerPanel report={report} />);
    await expect.element(screen.getByText("20.0% lower", { exact: true })).toBeVisible();
    await screen.getByRole("combobox", { name: "TokenEconomizer model" }).click();
    await page.getByRole("option", { name: "model-b", exact: true }).click();
    await expect.element(screen.getByText("100.0% higher", { exact: true })).toBeVisible();
    await expect.element(screen.getByText(/does not establish financial ROI/)).toBeVisible();
  });
});
