import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { firstZipEntry, LayoutDriftError, zipEntries } from "./zip.ts";

const EFILE_FIXTURES = new URL("../fixtures/efile/", import.meta.url);

/** The temp directory this file's Deflate64 reads write under, so a leftover shows. */
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "zip-test-"));
  vi.stubEnv("TMPDIR", scratch);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

test("a Deflate64 entry from an IRS batch zip inflates", async () => {
  // one entry cut from 2026_TEOS_XML_05B.zip with its compressed bytes untouched
  const path = fileURLToPath(new URL("deflate64.zip", EFILE_FIXTURES));
  const read: [string, string][] = [];
  for await (const entry of zipEntries(path)) {
    read.push([entry.name, await new Response(entry.read()).text()]);
  }
  // the fixture holds the same return trimmed after its form
  const trimmed = await readFile(
    new URL("xml/202631339349308133_public.xml", EFILE_FIXTURES),
    "utf8",
  );
  // Response#text drops the byte-order mark readFile keeps
  const form = trimmed.slice(1, trimmed.indexOf("</IRS990>"));
  expect(read).toHaveLength(1);
  expect(read[0]?.[0]).toBe("202631339349308133_public.xml");
  expect(read[0]?.[1].startsWith(form)).toBe(true);
});

test.each([1, 3, 4096, Number.POSITIVE_INFINITY])(
  "a Deflate64 entry streamed %d bytes at a time inflates, leaving no temp file",
  async (size) => {
    const bytes = await readFile(new URL("deflate64.zip", EFILE_FIXTURES));
    const parts: Uint8Array[] = [];
    for await (const chunk of firstZipEntry(slices(bytes, size))) {
      parts.push(chunk);
    }
    const text = await new Response(new Blob(parts)).text();
    const trimmed = await readFile(
      new URL("xml/202631339349308133_public.xml", EFILE_FIXTURES),
      "utf8",
    );
    const form = trimmed.slice(1, trimmed.indexOf("</IRS990>"));
    expect(text.startsWith(form)).toBe(true);
    expect(await readdir(scratch)).toStrictEqual([]);
  },
);

test("a Deflate64 read stopped after its first chunk cancels the entry and leaves no temp file", async () => {
  const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
  const bytes = await readFile(new URL("deflate64.zip", EFILE_FIXTURES));
  for await (const chunk of firstZipEntry(slices(bytes, 4096))) {
    expect(chunk.length).toBeGreaterThan(0);
    break;
  }
  expect(cancel).toHaveBeenCalledOnce();
  expect(await readdir(scratch)).toStrictEqual([]);
});

test("a Deflate64 read to the end does not cancel the entry", async () => {
  const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
  const bytes = await readFile(new URL("deflate64.zip", EFILE_FIXTURES));
  for await (const _ of firstZipEntry(slices(bytes, 4096))) {
    // read every chunk
  }
  expect(cancel).not.toHaveBeenCalled();
});

test.each([
  ["cut short", "zip archive holds no complete file", "cut"],
  ["listing no files", "zip archive holds no complete file", "empty"],
] as const)(
  "a Deflate64 archive %s holds no complete file, leaving no temp file",
  async (_, message, shape) => {
    const bytes = await readFile(new URL("deflate64.zip", EFILE_FIXTURES));
    const archive =
      shape === "cut" ? bytes.subarray(0, bytes.length / 2) : emptyArchive();
    const caught = await failure(firstZipEntry(slices(archive, 4096)));
    expect(caught).not.toBeInstanceOf(LayoutDriftError);
    expect(caught).toMatchObject({ message });
    expect(await readdir(scratch)).toStrictEqual([]);
  },
);

test("an encrypted Deflate64 entry is a layout error naming zip.js's detail", async () => {
  const caught = await failure(
    firstZipEntry(slices(methodZip(9, new Uint8Array(32), 1), 4096)),
  );
  expect(caught).toBeInstanceOf(LayoutDriftError);
  expect(caught).toMatchObject({
    message:
      "zip's Deflate64 entry did not inflate: File contains encrypted entry",
    cause: { message: "File contains encrypted entry" },
  });
  expect(await readdir(scratch)).toStrictEqual([]);
});

test("a corrupt Deflate64 entry is a plain error carrying zip.js's", async () => {
  const caught = await failure(
    firstZipEntry(slices(methodZip(9, new Uint8Array([0, 1, 2, 3])), 4096)),
  );
  expect(caught).not.toBeInstanceOf(LayoutDriftError);
  expect(caught).toMatchObject({
    message: "zip's Deflate64 entry did not inflate",
    cause: { message: "Invalid compressed data" },
  });
  expect(await readdir(scratch)).toStrictEqual([]);
});

test("a compression method fflate cannot inflate is a layout error", async () => {
  const caught = await failure(firstZipEntry(slices(methodZip(14), 1)));
  expect(caught).toBeInstanceOf(LayoutDriftError);
  expect(caught).toMatchObject({
    name: "LayoutDriftError",
    message: "zip uses compression method 14",
  });
});

/** What reading all of `entry` throws. */
async function failure(entry: AsyncIterable<Uint8Array>): Promise<unknown> {
  try {
    for await (const chunk of entry) void chunk;
  } catch (error) {
    return error;
  }
  throw new Error("the read did not fail");
}

/** `bytes` in slices of `size`, so a header can span reads. */
async function* slices(
  bytes: Uint8Array,
  size: number,
): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) {
    yield bytes.subarray(i, i + size);
  }
}

/**
 * One entry of `method` around `payload`, with general purpose `flags`, then
 * the central directory and end record that list it.
 */
function methodZip(
  method: number,
  payload = new Uint8Array([1, 2, 3, 4]),
  flags = 0,
): Uint8Array {
  const name = new TextEncoder().encode("a.txt");
  const local = new Uint8Array(30 + name.length + payload.length);
  const view = new DataView(local.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(6, flags, true);
  view.setUint16(8, method, true);
  view.setUint32(18, payload.length, true);
  view.setUint16(26, name.length, true);
  local.set(name, 30);
  local.set(payload, 30 + name.length);
  const central = new Uint8Array(46 + name.length);
  const entry = new DataView(central.buffer);
  entry.setUint32(0, 0x02014b50, true);
  entry.setUint16(8, flags, true);
  entry.setUint16(10, method, true);
  entry.setUint32(20, payload.length, true);
  entry.setUint16(28, name.length, true);
  central.set(name, 46);
  return concat(local, central, endRecord(1, central.length, local.length));
}

/** A method-9 local header with no data, then an end record listing no files. */
function emptyArchive(): Uint8Array {
  const local = new Uint8Array(30);
  const view = new DataView(local.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(8, 9, true);
  return concat(local, endRecord(0, 0, local.length));
}

function endRecord(entries: number, size: number, offset: number): Uint8Array {
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries, true);
  view.setUint16(10, entries, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  return end;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
