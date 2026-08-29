import { describe, it, strict } from "poku";
import {
  adapterCapabilities,
  createAdapterCapabilityResolver,
  defineAdapterCapability,
  getAdapterCapability,
  hasAdapterCapability,
  requireAdapterCapability,
  UnsupportedAdapterCapabilityError,
} from "../src/index.js";

interface ExampleService {
  readonly execute: () => string;
}

await describe("adapter capabilities", async () => {
  const example = defineAdapterCapability<ExampleService>("example.bulk");
  const service: ExampleService = Object.freeze({ execute: () => "available" });
  const host = {
    [adapterCapabilities]: createAdapterCapabilityResolver([[example, service]]),
  };

  await it("discovers optional services without widening their type", () => {
    strict.strictEqual(getAdapterCapability(host, example), service);
    strict.strictEqual(requireAdapterCapability(host, example).execute(), "available");
    strict.strictEqual(hasAdapterCapability(host, example), true);
  });

  await it("uses globally stable keys for separately defined tokens", () => {
    const secondCopy = defineAdapterCapability<ExampleService>("example.bulk");
    strict.strictEqual(getAdapterCapability(host, secondCopy), service);
  });

  await it("fails closed for absent capabilities", () => {
    const missing = defineAdapterCapability<ExampleService>("example.missing");
    strict.strictEqual(getAdapterCapability(host, missing), undefined);
    strict.strictEqual(hasAdapterCapability({}, missing), false);
    strict.throws(
      () => requireAdapterCapability(host, missing),
      (error) =>
        error instanceof UnsupportedAdapterCapabilityError &&
        error.code === "TSQL_UNSUPPORTED_ADAPTER_CAPABILITY" &&
        error.capability === "example.missing",
    );
  });

  await it("rejects ambiguous capability declarations", () => {
    strict.throws(() => defineAdapterCapability<ExampleService>("bulk"), /namespaced/u);
    strict.throws(
      () =>
        createAdapterCapabilityResolver([
          [example, service],
          [example, service],
        ]),
      /Duplicate adapter capability/u,
    );
  });
});
