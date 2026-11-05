import find from "./find.sql";

find({ orderId: 9001n });
// @ts-expect-error SQL BIGINT named attributes require bigint.
find({ orderId: "9001" });
// @ts-expect-error SQL-file named attributes retain their actual names.
find({ id: 9001n });
