import { it, strict } from "poku";
import { utf8ByteLength } from "../src/utf8.js";

await it("counts UTF-8 bytes without Buffer using Node's exact replacement-character behavior", () => {
  const values = [
    "",
    "SELECT id",
    "é\u07ff",
    "\u0800漢",
    "😀🦕",
    "\ud800",
    "\udc00",
    "\ud800x\udc00",
    "\ud800\ud800\udc00",
  ];
  const expected = values.map((value) => Buffer.byteLength(value, "utf8"));
  strict.deepStrictEqual(values.map(utf8ByteLength), expected);
  const buffer = globalThis.Buffer;
  let actual: number[];
  try {
    Reflect.set(globalThis, "Buffer", undefined);
    actual = values.map(utf8ByteLength);
  } finally {
    Reflect.set(globalThis, "Buffer", buffer);
  }
  strict.deepStrictEqual(actual, expected);
});
