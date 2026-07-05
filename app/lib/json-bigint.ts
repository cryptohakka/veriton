/**
 * SPDX-License-Identifier: MIT
 * NextResponse.json() cannot serialize BigInt. Assertions carry a BigInt
 * `expected` field (uint256), so any response including one must route
 * through this helper instead of calling NextResponse.json() directly.
 */
export function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}
