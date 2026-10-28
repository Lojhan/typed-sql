import { it, strict } from "poku";
import { mySqlServerEvidence, mysql } from "../src/index.js";

await it("uses snapshot SQL mode to distinguish MySQL parameters from strings and comments", () => {
  const dialect = mysql();
  const source = "SELECT 'a\\' , ? -- ', ?";
  const positions = ["", "NO_BACKSLASH_ESCAPES"].map((sqlMode) => {
    const schema = dialect.validateSnapshot({
      formatVersion: 1,
      dialect: "mysql",
      tables: {},
      server: mySqlServerEvidence("8.0.45", sqlMode),
    });
    return dialect.parameterOccurrences!(source, schema).map(({ range }) => range.start);
  });
  strict.deepStrictEqual(positions, [[source.lastIndexOf("?")], [source.indexOf("?")]]);
});
