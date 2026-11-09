import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEVER_BUILT, type ServedPointer } from "@nonprofits/db";
import { appDbFixture } from "@nonprofits/db/fixture";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type CliDeps, run } from "./cli.ts";
import { localDatabases } from "./database-host.ts";
import { ALERT_DAY, checkSchedule, outputLines } from "./schedule.ts";
import { FIXTURE_COUNTS } from "./test-support.ts";

const pointer = (build_id: string, switched_at: string): ServedPointer => ({
  database: { name: `nonprofits-data-${build_id}`, url: "libsql://x" },
  build_id,
  switched_at,
});

const SEPT = pointer("20260903T061700Z", "2026-09-03T06:20:00Z");
const NOV = pointer("20260907T071000Z", "2026-11-03T07:20:00Z");
const NEVER = { database: null, build_id: NEVER_BUILT, switched_at: "x" };

describe("checkSchedule", () => {
  test("skips with 'already imported <build id>' once this UTC month's build is live", () => {
    const check = checkSchedule(NOV, new Date("2026-11-03T14:11:00Z"), false);

    expect(check).toMatchObject({
      proceed: false,
      summary: "already imported 20260907T071000Z",
      alert: "",
    });
  });

  test("proceeds when the served build is from an earlier month, or none was ever built", () => {
    const now = new Date("2026-11-03T06:17:00Z");

    expect(checkSchedule(SEPT, now, false).proceed).toBe(true);
    expect(checkSchedule(NEVER, now, false).proceed).toBe(true);
  });

  test("proceeds when forced, though the month is live", () => {
    const check = checkSchedule(NOV, new Date("2026-11-04T06:17:00Z"), true);

    expect(check.proceed).toBe(true);
    expect(check.alert).toBe("");
  });

  test("a switch late on the 30th UTC is not this month's on the 1st", () => {
    const oct = pointer("b", "2026-10-31T23:59:59Z");

    expect(
      checkSchedule(oct, new Date("2026-11-01T00:00:00Z"), false).proceed,
    ).toBe(true);
    expect(
      checkSchedule(oct, new Date("2026-10-31T23:59:59Z"), false).proceed,
    ).toBe(false);
  });

  test("a pointer whose time can't be read never counts as imported", () => {
    expect(
      checkSchedule(
        pointer("b", "garbage"),
        new Date("2026-11-03T06:00:00Z"),
        false,
      ).proceed,
    ).toBe(true);
  });
});

describe("the alert", () => {
  const now = (day: number) => new Date(Date.UTC(2026, 10, day, 6, 17));

  test(`is raised from the ${ALERT_DAY}th with nothing published this month`, () => {
    const alert = checkSchedule(SEPT, now(ALERT_DAY), false).alert;

    expect(alert).toContain("No build was switched in 2026-11 by the 5th");
    expect(alert).not.toContain("\n");
    expect(checkSchedule(SEPT, now(7), false).alert).not.toBe("");
  });

  test("is not raised before the 5th", () => {
    expect(checkSchedule(SEPT, now(ALERT_DAY - 1), false).alert).toBe("");
  });

  test("is not raised once a build is switched this month", () => {
    expect(checkSchedule(NOV, now(ALERT_DAY), false).alert).toBe("");
  });

  test("is raised for a database that never built anything", () => {
    expect(checkSchedule(NEVER, now(ALERT_DAY), false).alert).not.toBe("");
  });
});

test("outputLines writes one key=value line each for GITHUB_OUTPUT", () => {
  expect(outputLines({ proceed: true, alert: "a\nb", summary: "s" })).toBe(
    "proceed=true\nalert=a b\n",
  );
});

describe("the check command, over a local app database", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(cleanups.splice(0).map((c) => c()));
  });

  /** Runs `check` at `at` over a pointer set to `served`; resolves the exit code, stdout and the output file. */
  async function check(
    served: ServedPointer | null,
    at: string,
    args: string[] = [],
  ) {
    const app = await appDbFixture();
    const dir = await mkdtemp(join(tmpdir(), "schedule-"));
    cleanups.push(async () => {
      await app.dispose();
      await rm(dir, { recursive: true, force: true });
    });
    if (served !== null) {
      await app.client.execute({
        sql: "UPDATE served_database SET database_name = ?, database_url = ?, build_id = ?, switched_at = ? WHERE id = 1",
        args: [
          served.database?.name ?? null,
          served.database?.url ?? null,
          served.build_id,
          served.switched_at,
        ],
      });
    }
    const out = join(dir, "output");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await run(["check", ...args, "--output", out], {}, {
      databases: () => ({ app: app.client, host: localDatabases(dir) }),
      sources: () => {
        throw new Error("not reached");
      },
      floors: FIXTURE_COUNTS,
      loadDir: join(dir, "load"),
      dataFile: join(dir, "data.db"),
      now: () => new Date(at),
      onSignal: () => {},
      exit: () => {},
    } satisfies CliDeps);
    const printed = log.mock.calls.map((c) => c.join(" "));
    return {
      code,
      printed,
      output: await readFile(out, "utf8").catch(() => ""),
    };
  }

  test("skips the import and says which build is already live", async () => {
    const r = await check(NOV, "2026-11-04T06:17:00Z");

    expect(r.code).toBe(0);
    expect(r.printed).toStrictEqual(["already imported 20260907T071000Z"]);
    expect(r.output).toBe("proceed=false\nalert=\n");
  });

  test("proceeds and alerts on the 5th when the data is from an earlier month", async () => {
    const r = await check(SEPT, "2026-11-05T06:17:00Z");

    expect(r.output).toMatch(
      /^proceed=true\nalert=No build was switched in 2026-11 by the 5th/,
    );
  });

  test("--force proceeds although the month is live", async () => {
    const r = await check(NOV, "2026-11-04T06:17:00Z", ["--force"]);

    expect(r.output).toBe("proceed=true\nalert=\n");
  });

  test("proceeds on a database never built, and the alert is quiet before the 5th", async () => {
    const r = await check(null, "2026-11-03T06:17:00Z");

    expect(r.output).toBe("proceed=true\nalert=\n");
  });
});
