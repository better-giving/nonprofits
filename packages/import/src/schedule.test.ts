import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEVER_BUILT, type ServedPointer } from "@nonprofits/db";
import { appDbFixture } from "@nonprofits/db/fixture";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type CliDeps, openAppDatabase, openDatabases, run } from "./cli.ts";
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

  test("a switch late on the 31st UTC is not the next month's on the 1st", () => {
    const oct = pointer("b", "2026-10-31T23:59:59Z");

    expect(
      checkSchedule(oct, new Date("2026-11-01T00:00:00Z"), false).proceed,
    ).toBe(true);
    expect(
      checkSchedule(oct, new Date("2026-10-31T23:59:59Z"), false).proceed,
    ).toBe(false);
  });

  test("a build_id of NEVER_BUILT is not imported, whatever its switched_at says", () => {
    const check = checkSchedule(
      { ...NEVER, switched_at: "2026-11-03T07:20:00Z" },
      new Date("2026-11-04T06:17:00Z"),
      false,
    );

    expect(check.proceed).toBe(true);
    expect(check.summary).toBe("importing: nothing has been built yet");
  });

  test("says what it does: skip, import, or force", () => {
    const at = new Date("2026-11-06T06:17:00Z");

    expect(checkSchedule(SEPT, at, false).summary).toBe(
      "importing: serving build 20260903T061700Z, switched 2026-09-03T06:20:00Z",
    );
    expect(checkSchedule(NOV, at, true).summary).toBe(
      "forced: 20260907T071000Z is already this month's build",
    );
  });

  test("a forced run with nothing published still raises the alert", () => {
    const check = checkSchedule(SEPT, new Date("2026-11-06T06:17:00Z"), true);

    expect(check.proceed).toBe(true);
    expect(check.alert).toContain("No build was switched in 2026-11");
    expect(check.summary).toMatch(/^importing: /);
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
    expect(alert).toMatch(/ This run is importing 2026-11 now\.$/);
    expect(checkSchedule(SEPT, now(7), false).alert).not.toBe("");
  });

  test("is not raised before the 5th", () => {
    expect(checkSchedule(SEPT, now(ALERT_DAY - 1), false).alert).toBe("");
  });

  test("is not raised once a build is switched this month", () => {
    expect(checkSchedule(NOV, now(ALERT_DAY), false).alert).toBe("");
  });

  test("is not raised on a forced run once a build is switched this month", () => {
    const check = checkSchedule(NOV, now(ALERT_DAY), true);

    expect(check.proceed).toBe(true);
    expect(check.alert).toBe("");
  });

  test("is raised for a database that never built anything, saying so", () => {
    expect(checkSchedule(NEVER, now(ALERT_DAY), false).alert).toBe(
      "No build was switched in 2026-11 by the 5th (UTC); nothing has been built yet. This run is importing 2026-11 now.",
    );
  });

  test("names the build still served when one was built earlier", () => {
    expect(checkSchedule(SEPT, now(ALERT_DAY), false).alert).toBe(
      "No build was switched in 2026-11 by the 5th (UTC); still serving build 20260903T061700Z, switched 2026-09-03T06:20:00Z. This run is importing 2026-11 now.",
    );
  });
});

// each case pins TZ itself, so a getDate or month read in local time moves a boundary here whatever zone the machine runs in
describe.each(["America/Los_Angeles", "Pacific/Auckland"])(
  "the UTC boundaries, read in %s",
  (zone) => {
    beforeEach(() => {
      vi.stubEnv("TZ", zone);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    test("the zone is in effect", () => {
      // 23:30 UTC is the next calendar day in Auckland, the same one in Los Angeles
      const local = new Date("2026-11-04T23:30:00Z").getDate();

      expect(local).toBe(zone === "Pacific/Auckland" ? 5 : 4);
    });

    test("the alert starts at 00:00 UTC on the 5th, not a second before", () => {
      const sept = (iso: string) => checkSchedule(SEPT, new Date(iso), false);

      expect(sept("2026-11-04T23:59:59Z").alert).toBe("");
      expect(sept("2026-11-05T00:00:00Z").alert).not.toBe("");
    });

    test("a switch at the end of October UTC is October's, and November's from the 1st", () => {
      const oct = pointer("b", "2026-10-31T23:59:59Z");

      expect(
        checkSchedule(oct, new Date("2026-10-31T23:59:59Z"), false).proceed,
      ).toBe(false);
      expect(
        checkSchedule(oct, new Date("2026-11-01T00:00:00Z"), false).proceed,
      ).toBe(true);
    });
  },
);

describe("outputLines", () => {
  test("writes one key=value line each for GITHUB_OUTPUT", () => {
    expect(outputLines({ proceed: true, alert: "a\nb", summary: "s" })).toBe(
      "proceed=true\nalert=a b\n",
    );
  });

  test("collapses every run of CR and LF in the alert into one space", () => {
    const alert = "a\r\nb\rc\n\nd";

    expect(outputLines({ proceed: false, alert, summary: "s" })).toBe(
      "proceed=false\nalert=a b c d\n",
    );
  });
});

describe("the check command, over a local app database", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(cleanups.splice(0).map((c) => c()));
  });

  /**
   * Runs `check` at `at` over a pointer set to `served`, with `env` as the
   * process env; resolves the exit code, stdout, stderr, the output file and
   * the env each app database open was given. `before` is what the file
   * already holds, and `output: false` leaves `--output` off. Opening the
   * databases with their host fails the run.
   */
  async function check(
    served: ServedPointer | null,
    at: string,
    {
      args = [],
      before = null,
      output: withOutput = true,
      env = {},
    }: {
      args?: string[];
      before?: string | null;
      output?: boolean;
      env?: Record<string, string>;
    } = {},
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
    if (before !== null) await writeFile(out, before);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const argv = ["check", ...args, ...(withOutput ? ["--output", out] : [])];
    const opened: unknown[] = [];
    const code = await run(argv, env, {
      databases: () => {
        throw new Error("opened the data databases' host");
      },
      appDatabase: (given) => {
        opened.push(given);
        return app.client;
      },
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
      errors: err.mock.calls.map((c) => c.join(" ")),
      written: existsSync(out),
      output: await readFile(out, "utf8").catch(() => ""),
      opened,
    };
  }

  const CLOUD_APP_DB = "libsql://nonprofits-app-acme.aws-us-east-1.turso.io";

  test("reads a Turso Cloud app database without the Platform API settings", async () => {
    const env = {
      TURSO_APP_DB_URL: CLOUD_APP_DB,
      TURSO_APP_DB_TOKEN: "test-only-app-db-token-0123456789abcdef",
    };
    const r = await check(NOV, "2026-11-04T06:17:00Z", { env });

    expect(r.code).toBe(0);
    expect(r.printed).toStrictEqual(["already imported 20260907T071000Z"]);
    expect(r.opened).toStrictEqual([env]);
  });

  test("its open of a Turso Cloud app database needs no Platform settings", () => {
    // both throw before a client exists, so neither reaches the network
    const env = { TURSO_APP_DB_URL: CLOUD_APP_DB };
    const local = { appDb: "file:unused.db", dataDir: "unused" };

    expect(() => openAppDatabase(env, local.appDb)).toThrow(
      /^TURSO_APP_DB_TOKEN is not set$/,
    );
    expect(() => openDatabases(env, local)).toThrow(
      /^TURSO_PLATFORM_TOKEN, TURSO_ORG, TURSO_GROUP not set/,
    );
  });

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
    const r = await check(NOV, "2026-11-04T06:17:00Z", { args: ["--force"] });

    expect(r.output).toBe("proceed=true\nalert=\n");
  });

  test("proceeds on a database never built, and the alert is quiet before the 5th", async () => {
    const r = await check(null, "2026-11-03T06:17:00Z");

    expect(r.output).toBe("proceed=true\nalert=\n");
  });

  test("appends to an output file that already has lines", async () => {
    const r = await check(NOV, "2026-11-04T06:17:00Z", {
      before: "earlier=1\n",
    });

    expect(r.output).toBe("earlier=1\nproceed=false\nalert=\n");
  });

  test("without --output prints the summary and writes no file", async () => {
    const r = await check(NOV, "2026-11-04T06:17:00Z", { output: false });

    expect(r.code).toBe(0);
    expect(r.printed).toStrictEqual(["already imported 20260907T071000Z"]);
    expect(r.written).toBe(false);
  });

  test("exits 2 on a flag it doesn't take, naming it, and writes nothing", async () => {
    const r = await check(NOV, "2026-11-04T06:17:00Z", {
      args: ["--summary", "s.md"],
    });

    expect(r.code).toBe(2);
    expect(r.errors[0]).toBe("check takes no --summary");
    expect(r.printed).toStrictEqual([]);
    expect(r.written).toBe(false);
  });
});
