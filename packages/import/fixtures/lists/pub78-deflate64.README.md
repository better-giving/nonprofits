# `pub78-deflate64.zip`

A real Deflate64 (zip method 9) archive of one Pub 78-shaped list file, used by
`lists.test.ts` to exercise the Deflate64 branch of the list-zip import the way
the IRS ships some of its revocation and Pub 78 zips. The single entry,
`data-download-pub78.txt`, is `EIN|NAME|CITY|STATE|COUNTRY|DEDUCTIBILITY` rows in
EIN order, CRLF-terminated.

The stream is genuinely Deflate64, not a method-9 header over plain Deflate: two
rows carry the same long `NAME` on either side of a ~35 KB filler row, so the
second copy sits more than 32 KB back in the decompressed stream. The compressor
reaches it with a Deflate64-only distance code (30/31, 64 KB window), which a
plain Deflate reader cannot inflate, so the fixture breaks if the Deflate64 path
breaks.

## Regenerate

Needs [7-Zip](https://www.7-zip.org/) (tested with 23.01; its zip handler writes
Deflate64). From a scratch directory:

```sh
python3 - <<'PY'
block = ("RESCUE MISSION OF THE GREATER METRO AREA " * 22).strip()
filler = ("THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG " * 800).strip()
rows = [
    "000587764|Iglesia Bethesda Inc.|Lowell|MA|United States|PC",
    "010043788|Green Valley Relief Association|Island Falls|ME|United States|PC",
    f"222222222|{block}|Metropolis|NY|United States|PC",
    f"333333333|{filler}|Metropolis|NY|United States|PC",
    f"444444444|{block}|Metropolis|NY|United States|PC",
    "530196605|American National Red Cross|Washington|DC|United States|PC",
    "999999010|Association of Fundraising Professionals|Arlington|VA|United States|PC",
]
open("data-download-pub78.txt", "wb").write(("\r\n".join(rows) + "\r\n").encode())
PY

7z a -tzip -mm=Deflate64 -mx=9 pub78-deflate64.zip data-download-pub78.txt
```
