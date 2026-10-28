import { describe, expect, test } from "vitest";
import {
  DAILY_ROWS_READ,
  DEFAULT_SERVICE_DAILY_LIMIT,
  WORST_REQUEST_ROWS_READ,
} from "./quota.ts";

describe("DEFAULT_SERVICE_DAILY_LIMIT", () => {
  test("leaves a quarter of the day's reads when every admitted request is the worst search", () => {
    const ceilings = Object.values(DEFAULT_SERVICE_DAILY_LIMIT).reduce(
      (sum, ceiling) => sum + ceiling,
      0,
    );

    expect(ceilings * WORST_REQUEST_ROWS_READ).toBeLessThanOrEqual(
      DAILY_ROWS_READ * 0.75,
    );
  });
});
