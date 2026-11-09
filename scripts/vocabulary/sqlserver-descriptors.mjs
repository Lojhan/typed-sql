import assert from "node:assert/strict";

/** Discover names from sys.types, including builtin aliases/CLR types; never copy a type-name inventory. */
export function sqlServerDescriptorCases(rows) {
  assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= 1000);
  const integer = (value) => {
    assert.ok(typeof value === "number" || (typeof value === "string" && /^\d+$/u.test(value)));
    const number = Number(value);
    assert.ok(Number.isSafeInteger(number) && number > 0);
    return number;
  };
  const inventory = rows
    .map((row) => {
      assert.equal(row.namespace, "sys");
      assert.match(row.name, /^[a-z][a-z0-9_]*$/u);
      assert.ok([false, 0, "0"].includes(row.is_user_defined));
      assert.ok([true, false, 0, 1, "0", "1"].includes(row.is_assembly_type));
      return { ...row, system_type_id: integer(row.system_type_id), user_type_id: integer(row.user_type_id) };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  assert.equal(new Set(inventory.map(({ name }) => name)).size, inventory.length);
  assert.equal(new Set(inventory.map(({ user_type_id }) => user_type_id)).size, inventory.length);
  const cases = inventory.map((type, index) => ({ origin: "catalog", type: type.name, catalog: index }));
  // Concrete facet controls complement discovery, not a list of engine names or universal family rules.
  for (const type of [
    "decimal(1,0)",
    "decimal(38,38)",
    "varchar(max)",
    "nvarchar(max)",
    "varbinary(max)",
    "datetime2(3)",
    "time(0)",
    "datetimeoffset(7)",
    "float(24)",
    "float(53)",
  ])
    cases.push({ origin: "modifier-control", type, catalog: null });
  return { inventory, cases };
}

/** Only recognized statement diagnostics may become observations; availability errors fail the audit. */
export function sqlServerDescriptorErrors(numbers) {
  assert.ok(Array.isArray(numbers) && numbers.length > 0 && numbers.length <= 32);
  assert.ok(numbers.every((number) => Number.isSafeInteger(number) && number > 0));
  // Documented comparison/conversion errors: https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/database-engine-events-and-errors-0-to-999
  const statement = new Set([102, 156, 206, 243, 257, 305, 306, 402, 529, 2715, 8114, 8116]);
  if (numbers.some((number) => !statement.has(number) && !(number >= 11501 && number <= 11599)))
    throw new TypeError(`Unclassified SQL Server metadata diagnostic: ${numbers.join(",")}`);
  return { status: numbers.some((number) => statement.has(number)) ? "rejected" : "unavailable", numbers };
}

export function sqlServerDescriptorFailure(error) {
  const diagnostics = error && typeof error === "object" ? error.diagnostics : undefined;
  if (!Array.isArray(diagnostics) || diagnostics.length === 0 || diagnostics.length > 32) throw error;
  if (diagnostics.some(({ state }) => typeof state !== "string" || (state !== "01000" && !/^(?:42|22)/u.test(state))))
    throw error;
  const numbers = [
    ...new Set(diagnostics.map(({ native }) => native).filter((value) => Number.isSafeInteger(value) && value > 0)),
  ];
  try {
    return sqlServerDescriptorErrors(numbers);
  } catch {
    throw error;
  }
}
