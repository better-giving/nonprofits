import type { Client, InStatement } from "@libsql/client";
import {
  FILING_SIZE_INDEX,
  matchExpression,
  ORGS_KEY_INDEX,
  searchSql,
} from "@nonprofits/db";
import { dataDbFixture, type LocalDb } from "@nonprofits/db/fixture";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WARMUP_TERMS, WarmupStopped, warmUploadedDatabase } from "./warmup.ts";

const FILINGS_SIZE_SQL = `SELECT total_revenue FROM filings INDEXED BY ${FILING_SIZE_INDEX} LIMIT 1`;
const ORGS_KEY_SQL = `SELECT ein FROM orgs INDEXED BY ${ORGS_KEY_INDEX} LIMIT 1`;

const empty = {
  columns: [],
  columnTypes: [],
  rows: [],
  rowsAffected: 0,
};

interface Sent {
  sql: string;
  args: unknown[];
}

function statementOf(statement: InStatement): Sent {
  if (typeof statement === "string") return { sql: statement, args: [] };
  const args = statement.args;
  return {
    sql: statement.sql,
    args: args === undefined ? [] : Array.isArray(args) ? [...args] : [args],
  };
}

function client(execute: (statement: InStatement) => Promise<unknown>): Client {
  return { execute } as Client;
}

describe("warmUploadedDatabase", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("runs each common term's search, then the filings size index, then the orgs key", async () => {
    const sent: Sent[] = [];
    const db = client(async (statement) => {
      sent.push(statementOf(statement));
      return empty;
    });

    const report = await warmUploadedDatabase({ db, now: () => 0 });

    expect(sent).toEqual([
      ...WARMUP_TERMS.map((term) => ({
        sql: searchSql(true),
        args: [matchExpression(term.split(" ")), 1],
      })),
      { sql: FILINGS_SIZE_SQL, args: [] },
      { sql: ORGS_KEY_SQL, args: [] },
    ]);
    expect(report.skipped).toBe(0);
    expect(report.warnings).toEqual([]);
    expect(report.queries.every((query) => query.ok)).toBe(true);
    expect(report.queries.slice(-2).map((query) => query.label)).toEqual([
      "filings_size index",
      "orgs key index",
    ]);
  });

  test("searches a multi-word term with every word the api would send", async () => {
    const sent: Sent[] = [];
    const db = client(async (statement) => {
      sent.push(statementOf(statement));
      return empty;
    });

    await warmUploadedDatabase({ db, now: () => 0 });

    expect(sent.map((statement) => statement.args[0])).toContain(
      '"boys" "and" "girls" "club"',
    );
    expect(sent.map((statement) => statement.args[0])).toContain(
      '"habitat" "for" "humanity"',
    );
  });

  test("times each query and the whole warm-up on its clock", async () => {
    let now = 0;
    const db = client(async () => {
      now += 1_500;
      return empty;
    });

    const report = await warmUploadedDatabase({ db, now: () => now });

    expect(report.queries[0]).toEqual({
      label: "united way",
      ok: true,
      seconds: 1.5,
    });
    expect(report.seconds).toBe(63);
    expect(report.summary).toBe("warm-up: 42 queries in 63.0 s");
  });

  test("stops once the budget is spent and warns, leaving the rest unstarted", async () => {
    let now = 0;
    let calls = 0;
    const db = client(async () => {
      calls += 1;
      if (calls === 2) now = 1_000;
      return empty;
    });

    const report = await warmUploadedDatabase({
      db,
      budgetMs: 1_000,
      now: () => now,
    });

    expect(calls).toBe(2);
    expect(report.skipped).toBe(40);
    expect(report.warnings).toEqual([
      "WARNING: warm-up stopped after 2 of 42 queries: budget 1 s spent, switching anyway",
    ]);
  });

  test("a query that fails is a warning and the later queries still run", async () => {
    let calls = 0;
    const db = client(async () => {
      calls += 1;
      if (calls === 2) throw new Error("disk I/O");
      return empty;
    });

    const report = await warmUploadedDatabase({ db, now: () => 0 });

    expect(calls).toBe(WARMUP_TERMS.length + 2);
    expect(report.queries[1]).toMatchObject({
      label: "church",
      ok: false,
      warning: 'WARNING: warm-up "church" failed after 0.0 s: disk I/O',
    });
    expect(report.queries.filter((query) => !query.ok)).toHaveLength(1);
    expect(report.warnings).toEqual([
      'WARNING: warm-up "church" failed after 0.0 s: disk I/O',
    ]);
    expect(report.skipped).toBe(0);
  });

  test("a query that outlasts its own time is a warning, the next query runs, and its late failure goes nowhere", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const db = client(
      () =>
        new Promise((resolve, reject) => {
          calls += 1;
          if (calls === 1) {
            setTimeout(() => reject(new Error("late failure")), 5_000);
            return;
          }
          resolve(empty);
        }),
    );

    const warming = warmUploadedDatabase({
      db,
      queryTimeoutMs: 1_000,
      now: () => 0,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const report = await warming;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(calls).toBe(WARMUP_TERMS.length + 2);
    expect(report.queries[0]?.warning).toBe(
      'WARNING: warm-up "united way" failed after 0.0 s: timed out after 1000 ms',
    );
    expect(report.queries[1]?.ok).toBe(true);
    expect(report.warnings).toHaveLength(1);
  });

  test("a query that starts near the budget's end waits only for what is left of it", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const db = client(() => {
      calls += 1;
      return new Promise((resolve) => {
        if (calls === 1) setTimeout(() => resolve(empty), 9_000);
      });
    });

    const warming = warmUploadedDatabase({
      db,
      budgetMs: 10_000,
      queryTimeoutMs: 60_000,
      now: () => Date.now(),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const report = await warming;

    expect(calls).toBe(2);
    expect(report.queries[1]?.warning).toBe(
      'WARNING: warm-up "church" failed after 1.0 s: timed out after 1000 ms',
    );
    expect(report.skipped).toBe(40);
  });

  test("an abort rejects and does not start another query", async () => {
    const signal = new AbortController();
    let calls = 0;
    const db = client(
      () =>
        new Promise(() => {
          calls += 1;
          signal.abort(new Error("stopped: SIGTERM"));
        }),
    );

    await expect(
      warmUploadedDatabase({ db, signal: signal.signal, now: () => 0 }),
    ).rejects.toThrow("stopped: SIGTERM");
    expect(calls).toBe(1);
  });

  test("an abort carries the report on the queries that ran before it", async () => {
    const signal = new AbortController();
    let calls = 0;
    const db = client(
      () =>
        new Promise((resolve) => {
          calls += 1;
          if (calls < 3) return resolve(empty);
          signal.abort(new Error("SIGTERM"));
        }),
    );

    const stopped = await warmUploadedDatabase({
      db,
      signal: signal.signal,
      now: () => 0,
    }).catch((error: unknown) => error);

    expect(stopped).toBeInstanceOf(WarmupStopped);
    const { report } = stopped as WarmupStopped;
    expect(report.queries.map((query) => query.label)).toEqual([
      "united way",
      "church",
    ]);
    expect(report.skipped).toBe(40);
    expect(report.warnings).toEqual([]);
    expect(report.summary).toBe(
      "warm-up: 2 queries in 0.0 s, then stopped with 40 not run",
    );
  });

  test("a query failure names its cause's code and message in the warning", async () => {
    const db = client(async () => {
      throw new Error("fetch failed", {
        cause: Object.assign(new Error("Headers Timeout Error"), {
          code: "UND_ERR_HEADERS_TIMEOUT",
        }),
      });
    });

    const report = await warmUploadedDatabase({ db, now: () => 0 });

    expect(report.warnings[0]).toBe(
      'WARNING: warm-up "united way" failed after 0.0 s: fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)',
    );
  });
});

describe("warmUploadedDatabase on a built database", () => {
  let data: LocalDb | undefined;

  afterEach(async () => {
    await data?.dispose();
    data = undefined;
  });

  test("the search and both index reads prepare", async () => {
    data = await dataDbFixture("20261017T000000Z");

    const report = await warmUploadedDatabase({ db: data.client });

    expect(report.queries).toHaveLength(WARMUP_TERMS.length + 2);
    expect(report.queries.every((query) => query.ok)).toBe(true);
    expect(report.skipped).toBe(0);
    expect(report.warnings).toEqual([]);
  });
});
