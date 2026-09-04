const prerequisites = {
  source: process.env.TYPED_SQL_SOURCE_RESULT,
  database: process.env.TYPED_SQL_DATABASE_RESULT,
  editor: process.env.TYPED_SQL_EDITOR_RESULT,
};

const unsuccessful = Object.entries(prerequisites).filter(([, result]) => result !== "success");
if (unsuccessful.length > 0) {
  throw new Error(`CI prerequisites did not succeed: ${unsuccessful.map(([name]) => name).join(", ")}`);
}
