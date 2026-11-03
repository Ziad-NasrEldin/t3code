import { describe, expect, it } from "vite-plus/test";
import { economizerComparison } from "./tokenEconomizerComparison";

describe("optimizer before-and-after comparison", () => {
  it("distinguishes missing samples from observed zero usage", () => {
    expect(economizerComparison(undefined)).toEqual({ before: null, after: null, change: null });
    expect(
      economizerComparison({
        model: "a",
        beforeSessions: 5,
        afterSessions: 0,
        beforeInputTokens: 5000,
        afterInputTokens: 0,
      }),
    ).toEqual({ before: 1000, after: null, change: null });
    expect(
      economizerComparison({
        model: "a",
        beforeSessions: 5,
        afterSessions: 5,
        beforeInputTokens: 5000,
        afterInputTokens: 0,
      }),
    ).toEqual({ before: 1000, after: 0, change: -100 });
  });
  it("suppresses percentages for small samples and a zero baseline", () => {
    expect(
      economizerComparison({
        model: "a",
        beforeSessions: 5,
        afterSessions: 4,
        beforeInputTokens: 5000,
        afterInputTokens: 1000,
      }).change,
    ).toBeNull();
    expect(
      economizerComparison({
        model: "a",
        beforeSessions: 5,
        afterSessions: 5,
        beforeInputTokens: 0,
        afterInputTokens: 1000,
      }).change,
    ).toBeNull();
  });
  it("normalizes by session count and keeps increased usage visible", () => {
    expect(
      economizerComparison({
        model: "a",
        beforeSessions: 10,
        afterSessions: 5,
        beforeInputTokens: 10000,
        afterInputTokens: 6000,
      }).change,
    ).toBeCloseTo(20);
  });
});
