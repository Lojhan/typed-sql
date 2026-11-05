import type { Query } from "@typed-sql/core";
import find from "./find.sql";
import insert from "./insert.sql";
import positional from "./positional.sql";

const named: Query<
  { id: bigint; name: string; payload: string; bytes: Uint8Array; maybe: string | null; real: number },
  readonly [bigint, bigint]
> = find({ id: 9223372036854775807n });
const ordered: Query<{ id: bigint; name: string }, readonly [string, bigint]> = positional("Ada", 1n);
insert({ id: 1n, name: "Ada", payload: "{}", bytes: Uint8Array.of(0), maybe: null });
// @ts-expect-error INTEGER identifiers use the selected bigint policy.
find({ id: "wrong" });
// @ts-expect-error Positional parameters follow SQL occurrence order.
positional(1n, "Ada");
// @ts-expect-error The named factory rejects omitted inputs.
insert({ id: 1n });
void named;
void ordered;
