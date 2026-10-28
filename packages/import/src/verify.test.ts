import { FILING_SIZE_INDEX } from "@nonprofits/db";
import { dataDbFixture, type LocalDb } from "@nonprofits/db/fixture";
import { afterEach, describe, expect, test } from "vitest";
import {
  type Check,
  checker,
  type ReadData,
  type TableFloors,
  verifyData,
  verifyFailure,
} from "./verify.ts";

const NO_FLOORS: TableFloors = {
  orgs: 0,
  filings: 0,
  programs: 0,
  in_pub78: 0,
  revocation_date: 0,
  files_990n: 0,
  bmf_run_id: 0,
};

let data: LocalDb | undefined;

afterEach(async () => {
  await data?.dispose();
  data = undefined;
});

async function sizeIndexCheck(db: LocalDb): Promise<Check | undefined> {
  const read: ReadData = async <T>(sql: string) =>
    (await db.client.execute(sql)).rows as unknown as T[];
  const checks: Check[] = [];
  await verifyData(read, {
    floors: NO_FLOORS,
    forceVerifyFailure: false,
    check: checker(checks, () => {}),
  });
  return checks.find((check) => check.name === "size index");
}

describe("verifyData's size index check", () => {
  test("passes a data database built with the filings size index", async () => {
    data = await dataDbFixture("20261017T000000Z");

    expect((await sizeIndexCheck(data))?.ok).toBe(true);
  });

  test("fails a data database without it, so verify blocks the build", async () => {
    data = await dataDbFixture("20261017T000000Z");
    await data.client.execute(`DROP INDEX ${FILING_SIZE_INDEX}`);

    const check = await sizeIndexCheck(data);

    expect(check?.ok).toBe(false);
    expect(verifyFailure("build x", check ? [check] : [])?.message).toBe(
      `verify failed for build x: size index (filings has no ${FILING_SIZE_INDEX}, which search ranks ties through)`,
    );
  });
});
