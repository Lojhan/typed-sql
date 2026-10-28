import { it, strict } from "poku";
import {
  createDatabase,
  defineQueryValuePlanSelector,
  encodeQueryValues,
  getQueryValuePlan,
  QueryValueError,
  type QueryValuePlan,
  queryResultValidationSource,
  renderQuery,
  type StandardSchemaV1,
  sql,
  validateQueryResultRows,
  withQueryValuePlan,
} from "../src/index.js";

const renderer = { placeholder: (index: number) => `@${index}`, quoteIdentifier: (name: string) => `[${name}]` };
const profile = { id: "fixture", dialect: "synthetic", integer: "lossless", jsonWire: "text" } as const;
const descriptor = (index: number, type: "string" | "number" | "boolean") => ({ index, type, nullable: false });
const plan: QueryValuePlan = {
  dialect: "synthetic",
  typePolicyHash: "fixture",
  columns: [],
  parameters: [descriptor(1, "string"), descriptor(2, "number"), descriptor(3, "number"), descriptor(4, "boolean")],
};
const choice = {
  sql: "P@1Aitem(@2), item(@3)S@4",
  plan,
  repeated: [
    {
      listIndex: 0,
      elementSql: "item(@1)",
      separatorSql: ", ",
      parameterOffset: 1,
      parameterCount: 1,
      representativeItems: 2 as const,
    },
  ],
};

await it("selects actual conditional structure and refuses mismatched SQL or parameter counts", () => {
  const selector = defineQueryValuePlanSelector(renderer, [
    { sql: "left @1", plan: { ...plan, parameters: [descriptor(1, "number")] } },
    { sql: "right @1", plan: { ...plan, parameters: [descriptor(1, "string")] } },
  ]);
  const make = (left: boolean, value: number | string) =>
    sql.__typedRow(selector)`${left ? sql.fragment`left ` : sql.fragment`right `}${value}`;
  const first = make(true, 1);
  const second = make(false, "next");
  const third = make(true, 3);
  strict.equal(getQueryValuePlan(first), getQueryValuePlan(third));
  strict.notEqual(getQueryValuePlan(first), getQueryValuePlan(second));
  strict.deepEqual(encodeQueryValues(first, renderQuery(first, renderer).values, profile), [1]);
  strict.deepEqual(encodeQueryValues(second, renderQuery(second, renderer).values, profile), ["next"]);
  strict.throws(() => sql.__typedRow(selector)`other ${1}`, QueryValueError);
  strict.throws(() => sql.__typedRow(selector)`${sql.raw("left @1")}`, QueryValueError);
});

await it("expands repeated contracts at real cardinalities without caching values and checks every item", () => {
  const selector = defineQueryValuePlanSelector(renderer, [choice]);
  const make = (values: readonly number[]) =>
    sql.__typedRow(selector)`P${"prefix"}A${values.map((value) => sql.fragment`item(${value})`)}S${true}`;
  const one = make([1]);
  const three = make([2, 3, 4]);
  const otherThree = make([5, 6, 7]);
  strict.equal(getQueryValuePlan(three), getQueryValuePlan(otherThree));
  strict.deepEqual(
    getQueryValuePlan(one)?.parameters.map((item) => [item.index, item.type]),
    [
      [1, "string"],
      [2, "number"],
      [3, "boolean"],
    ],
  );
  strict.deepEqual(encodeQueryValues(three, renderQuery(three, renderer).values, profile), ["prefix", 2, 3, 4, true]);
  strict.deepEqual(renderQuery(one, renderer).values, ["prefix", 1, true]);
  strict.deepEqual(renderQuery(three, renderer).values, ["prefix", 2, 3, 4, true]);
  strict.throws(() => make([]), /empty interpolated array/u);
  strict.throws(
    () =>
      sql.__typedRow(
        selector,
      )`P${"prefix"}A${[sql.fragment`item(${1})`, sql.fragment`item(${2})`, sql.fragment`changed(${3})`]}S${true}`,
    QueryValueError,
  );
  strict.throws(
    () => sql.__typedRow(selector)`changed${"prefix"}A${[sql.fragment`item(${1})`]}S${true}`,
    QueryValueError,
  );
  strict.throws(
    () => sql.__typedRow(selector)`P${"prefix"}A${[sql.fragment`item(${[sql.fragment`${1}`]})`]}S${true}`,
    QueryValueError,
  );
  for (let count = 2; count <= 34; count++) make(Array.from({ length: count }, (_, index) => index));
  strict.notEqual(
    getQueryValuePlan(make([1])),
    getQueryValuePlan(one),
    "evicted cardinalities do not retain an unbounded plan cache",
  );
});

await it("rejects incompatible repetition evidence before a query can use it", () => {
  strict.throws(() => defineQueryValuePlanSelector(renderer, []), TypeError);
  strict.throws(() => defineQueryValuePlanSelector(renderer, [choice, choice]), TypeError);
  strict.throws(
    () => defineQueryValuePlanSelector(renderer, [{ ...choice, sql: "x".repeat(4 * 1024 * 1024 + 1) }]),
    /size limit/u,
  );
  strict.throws(
    () =>
      defineQueryValuePlanSelector(renderer, [
        {
          ...choice,
          plan: {
            ...plan,
            parameters: [
              descriptor(1, "string"),
              descriptor(2, "number"),
              descriptor(3, "string"),
              descriptor(4, "boolean"),
            ],
          },
        },
      ]),
    /incompatible contexts/u,
  );
  for (const site of [
    { ...choice.repeated[0]!, listIndex: -1 },
    { ...choice.repeated[0]!, parameterOffset: -1 },
    { ...choice.repeated[0]!, parameterCount: -1 },
    { ...choice.repeated[0]!, parameterOffset: 4 },
  ])
    strict.throws(() => defineQueryValuePlanSelector(renderer, [{ ...choice, repeated: [site] }]), TypeError);
});

await it("keeps independent list patterns ordered when total parameter counts coincide", () => {
  const pattern: QueryValuePlan = {
    ...plan,
    parameters: [
      descriptor(1, "number"),
      descriptor(2, "number"),
      descriptor(3, "string"),
      descriptor(4, "string"),
      descriptor(5, "boolean"),
    ],
  };
  const select = defineQueryValuePlanSelector(renderer, [
    {
      sql: "Aitem(@1), item(@2)Btext(@3), text(@4)Z@5",
      plan: pattern,
      repeated: [
        {
          listIndex: 0,
          elementSql: "item(@1)",
          separatorSql: ", ",
          parameterOffset: 0,
          parameterCount: 1,
          representativeItems: 2,
        },
        {
          listIndex: 1,
          elementSql: "text(@1)",
          separatorSql: ", ",
          parameterOffset: 2,
          parameterCount: 1,
          representativeItems: 2,
        },
      ],
    },
  ]);
  const make = (numbers: readonly number[], strings: readonly string[]) =>
    sql.__typedRow(
      select,
    )`A${numbers.map((value) => sql.fragment`item(${value})`)}B${strings.map((value) => sql.fragment`text(${value})`)}Z${true}`;
  const left = make([1, 2, 3], ["a"]),
    right = make([4], ["b", "c", "d"]);
  strict.notEqual(getQueryValuePlan(left), getQueryValuePlan(right));
  strict.deepEqual(encodeQueryValues(left, renderQuery(left, renderer).values, profile), [1, 2, 3, "a", true]);
  strict.deepEqual(encodeQueryValues(right, renderQuery(right, renderer).values, profile), [4, "b", "c", "d", true]);
});

await it("requires fresh plans for changed SQL and preserves validators on the derived identity", async () => {
  const base = withQueryValuePlan(sql<{ id: number }>`SELECT id`, {
    ...plan,
    columns: [{ name: "id", type: "number", nullable: false }],
    parameters: [],
  });
  let calls = 0;
  const schema: StandardSchemaV1<unknown, { id: number }> = {
    "~standard": {
      version: 1,
      vendor: "fixture",
      validate(value: unknown) {
        calls++;
        return { value: value as { id: number } };
      },
    },
  };
  const validated = sql.validateResult(base, schema);
  for (const derived of [sql.append(validated, sql.fragment` ORDER BY id`), sql.where(validated, sql.fragment`true`)]) {
    strict.notEqual(queryResultValidationSource(derived), queryResultValidationSource(base));
    strict.equal(queryResultValidationSource(derived), derived);
    strict.throws(() => getQueryValuePlan(derived), QueryValueError);
    const verified = withQueryValuePlan(derived, {
      ...plan,
      columns: [{ name: "id", type: "number", nullable: false }],
      parameters: [],
    });
    strict.equal(getQueryValuePlan(verified)?.columns[0]?.name, "id");
    strict.deepEqual(await validateQueryResultRows(verified, [{ id: 1 }], "fixture"), [{ id: 1 }]);
    strict.throws(() => getQueryValuePlan(sql.append(verified, sql.fragment` LIMIT 1`)), QueryValueError);
  }
  strict.equal(calls, 2);
  strict.equal(getQueryValuePlan(base)?.columns[0]?.name, "id");
  strict.equal(sql.append(validated), validated);
  strict.equal(sql.append(validated, undefined, false, null, sql.empty), validated);
  strict.equal(getQueryValuePlan(sql.append(sql`SELECT 1`, sql.fragment` LIMIT 1`)), undefined);
});

await it("rejects public typed query copies instead of silently dropping metadata", () => {
  const query = withQueryValuePlan(sql<{ id: number }>`SELECT id`, {
    ...plan,
    columns: [{ name: "id", type: "number", nullable: false }],
    parameters: [],
  });
  const copy: typeof query = { ...query };
  strict.throws(() => getQueryValuePlan(copy), /copying query objects/);
  strict.throws(() => withQueryValuePlan(copy, plan), /copying query objects/);
  const validator: StandardSchemaV1<unknown, { id: number }> = {
    "~standard": { version: 1, vendor: "fixture", validate: (value) => ({ value: value as { id: number } }) },
  };
  const validated = sql.validateResult(query, validator);
  strict.equal(getQueryValuePlan(validated), getQueryValuePlan(query));
  const validatedCopy: typeof validated = { ...validated };
  strict.throws(() => getQueryValuePlan(validatedCopy), /copying query objects/);
  strict.throws(() => sql.where(copy, sql.fragment`true`), /copying query objects/);
});

await it("rejects planned queries and copied queries before generic executor dispatch", async () => {
  let dispatches = 0;
  const execute = async () => {
    dispatches++;
    return [{ id: 1 }];
  };
  const executor = {
    execute,
    executeControlled: execute,
    executionCapabilities: { cancellation: true, deadlines: true },
  };
  const database = createDatabase(executor, renderer);
  const plain = sql<{ id: number }>`SELECT id`;
  strict.deepEqual(await database.all(plain), [{ id: 1 }]);
  const query = withQueryValuePlan(sql<{ id: number }>`SELECT id`, {
    ...plan,
    columns: [{ name: "id", type: "number", nullable: false }],
    parameters: [],
  });
  await strict.rejects(database.all(query), /explicit transport profile/);
  await strict.rejects(database.all(query, { deadline: Date.now() + 1000 }), /explicit transport profile/);
  await strict.rejects(database.all({ ...query }), /copying query objects/);
  await strict.rejects(database.all({ ...plain }), /copying query objects/);
  strict.equal(dispatches, 1);
});
