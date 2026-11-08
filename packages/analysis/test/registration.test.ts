import { describe, it, strict } from "poku";
import { type AnalysisRegistration, defineAnalysisRegistration } from "../src/index.js";
import { fixture } from "./helpers/live-fixture.js";

const request = fixture(),
  context = request.staticClaim.context;
const configuration = {
  context,
  identity: {
    profileHash: context.profileHash,
    codecHash: context.codecHash,
    interpreterHash: context.interpreterHash,
  },
  qualification: request.policy,
};
await describe("explicit live registration", async () => {
  await it("keeps live factories cold and validates only declared boundaries", () => {
    let invoked = false;
    const adapter = () => {
      invoked = true;
      throw Error("not during registration");
    };
    strict.equal(defineAnalysisRegistration(configuration).mode, "offline");
    const selected = defineAnalysisRegistration({
      ...configuration,
      live: { adapter, deadlineMs: 50, batchDeadlineMs: 100, maxActive: 2, concurrencyPerContext: 1 },
    });
    strict.equal(selected.live?.adapter, adapter);
    strict.equal(invoked, false);
    strict.ok(Object.isFrozen(selected));
    strict.ok(Object.isFrozen(selected.live));
    const loadContributions = () => {
      invoked = true;
      throw Error("not during registration");
    };
    for (const live of [undefined, { adapter }]) {
      const registered = defineAnalysisRegistration({
        ...configuration,
        ...(live ? { live } : {}),
        projectCatalogs: { loadContributions, capture: true },
      });
      strict.equal(registered.projectCatalogs?.loadContributions, loadContributions);
      strict.ok(Object.isFrozen(registered.projectCatalogs));
    }
    for (const invalid of [
      null,
      [],
      new Date(),
      { ...configuration, [Symbol()]: true },
      {
        ...configuration,
        get live() {
          invoked = true;
          throw Error("accessor");
        },
      },
      { ...configuration, live: null },
      { ...configuration, live: {} },
      { ...configuration, live: { adapter: 1 } },
      { ...configuration, live: { adapter, extra: true } },
      { ...configuration, live: { adapter, deadlineMs: 0 } },
      { ...configuration, live: { adapter, batchDeadlineMs: 3_600_001 } },
      { ...configuration, live: { adapter, maxActive: 65 } },
      { ...configuration, live: { adapter, concurrencyPerContext: 1.5 } },
      { ...configuration, projectCatalogs: null },
      { ...configuration, projectCatalogs: {} },
      { ...configuration, projectCatalogs: { loadContributions: 1 } },
      { ...configuration, projectCatalogs: { loadContributions, extra: true } },
      { ...configuration, projectCatalogs: { loadContributions, capture: "all" } },
      {
        ...configuration,
        projectCatalogs: {
          get loadContributions() {
            invoked = true;
            return loadContributions;
          },
        },
      },
    ])
      strict.throws(() => defineAnalysisRegistration(invalid as AnalysisRegistration));
    strict.equal(invoked, false);
  });
});
