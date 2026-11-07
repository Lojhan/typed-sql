import { duckdbMapper } from "../../mappers/duckdb.mjs";
import { describeRoutine } from "../../model/build.mjs";
import { routineSignature } from "../../model/routines.mjs";
import { parseRoutine } from "../../model/schema.mjs";

const passingModes = ["positional-only", "positional-or-named", "variadic-positional", "named-only", "variadic-named"];
/** Source registrations enter the same validated routine contract as native captures.
 * @param {import('@sinclair/typebox').Static<typeof import('./facts.mjs').DuckDBRegistrationSchema>} registration
 */
export function sourceRoutine(registration) {
  let inputPosition = 0;
  const parameters =
    registration.parameters?.map((parameter, index) => {
      const defaultExpression =
        registration.macroDefaults.find((entry) => entry.name === parameter.name)?.expression ?? parameter.default;
      return {
        position: index + 1,
        inputPosition: parameter.kind === null || parameter.kind <= 1 ? ++inputPosition : null,
        name: parameter.name,
        nativeType: parameter.type,
        mode:
          parameter.kind === null || parameter.kind <= 1 ? "positional" : parameter.kind === 3 ? "named" : "variadic",
        passing: parameter.kind === null ? null : passingModes[parameter.kind],
        hasDefault: defaultExpression !== null,
        ...(defaultExpression === null ? {} : { defaultExpression }),
      };
    }) ?? null;
  const variadic = registration.parameters?.filter((parameter) => parameter.kind === 2 || parameter.kind === 4);
  const mapper = {
    ...duckdbMapper,
    parameterMode: (mode) => (mode === "variadic" ? "variadic" : duckdbMapper.parameterMode(mode)),
    routineFacts: () => ({
      parameters,
      returnsSet: ["table", "table_macro"].includes(registration.kind),
      identityKnowledge: "vendor-registration",
    }),
  };
  const routine = describeRoutine(
    routineSignature(mapper, {
      name: registration.name,
      kind: registration.kind,
      schema_name: registration.schema,
      result: registration.result,
      varargs: variadic?.[0]?.type ?? null,
      variadic: variadic ? variadic.length > 0 : null,
      macro_definition: registration.definition,
    }),
    mapper,
  );
  routine.properties.typedOptions = registration.options;
  return parseRoutine(routine);
}
