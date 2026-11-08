import { assertDialectProfile, type SchemaSnapshot } from "@typed-sql/core";
import type { NativeContractAdapter } from "./acquisition.js";
import type { AnalysisCacheToken } from "./cache.js";
import { canonicalContractData } from "./canonical.js";
import { createAnalysisContextScope, defineAnalysisConfiguration } from "./configuration.js";
import { assertContextScope } from "./context-scope.js";
import { parseQueryContractContext, type QueryContractContext } from "./contracts.js";
import type { LiveContractPreparation, LiveContractView } from "./live-view.js";
import {
  createProjectCatalogClosure,
  materializeProjectCatalogClosure,
  type ProjectCatalogClosure,
} from "./project-catalog.js";
import { acquireNativeProjectCatalog } from "./project-catalog-acquisition.js";
import { defineAnalysisRegistration, type LiveAnalysisServices } from "./registration.js";

class CatalogContextChangedError extends Error {}
const equal = (a: unknown, b: unknown) => canonicalContractData(a) === canonicalContractData(b);
/** Pure interpreter/factory work may finish late; owned transports receive the same abort signal. */
function abortable<Value>(work: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
/** A base adapter never receives an enriched schema or silently certifies its derived identities. */
export async function prepareCapturedCatalogView<Snapshot extends SchemaSnapshot, Policy>(
  input: LiveContractPreparation<Snapshot, Policy>,
  prepare: (input: LiveContractPreparation<Snapshot, Policy>) => Promise<LiveContractView<Snapshot, Policy>>,
): Promise<LiveContractView<Snapshot, Policy>> {
  const registration = defineAnalysisRegistration({
    ...input.configuration,
    live: input.live,
    projectCatalogs: input.projectCatalogs!,
  });
  const { live, projectCatalogs, ...data } = registration;
  const configuration = defineAnalysisConfiguration(data);
  assertDialectProfile(input.profile);
  if (
    !live ||
    !projectCatalogs?.capture ||
    configuration.mode !== "live" ||
    !configuration.cache ||
    "analyze" in input.profile
  )
    throw new TypeError("Selected catalog capture requires a live target and lightweight profile");
  const scope = createAnalysisContextScope(input);
  const policy = input.typePolicy ?? input.profile.defaultTypePolicy;
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;
  signal.throwIfAborted();
  const timer = setTimeout(
    () => controller.abort(new Error("Catalog capture batch deadline exceeded")),
    live.batchDeadlineMs ?? 60_000,
  );
  try {
    for (let attempt = 0; ; attempt++) {
      let owned: LiveAnalysisServices | undefined;
      let closure: ProjectCatalogClosure | undefined;
      let base: QueryContractContext | undefined;
      let closing: Promise<void> | undefined;
      const close = (services: LiveAnalysisServices) => (closing ??= Promise.resolve().then(() => services.close()));
      const creation = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return live.adapter({ schema: input.schema, typePolicy: policy, signal });
      });
      // Late factory results cannot escape the request that owned their construction.
      void creation
        .then(async (services) => {
          if (signal.aborted && services && typeof services.close === "function") await close(services);
        })
        .catch(() => {});
      const [operation] = await Promise.allSettled([
        (async () => {
          owned = await abortable(creation, signal);
          signal.throwIfAborted();
          if (!owned || typeof owned.close !== "function")
            throw new TypeError("Live catalog adapter requires owned cleanup");
          if (
            owned.connectionContext !== configuration.cache!.connectionContext ||
            owned.adapter?.id !== configuration.cache!.adapter.id ||
            owned.adapter.version !== configuration.cache!.adapter.version ||
            !equal(owned.adapter.grammar, scope.grammar) ||
            owned.contribution?.id !== configuration.qualification.owner.id ||
            owned.contribution.version !== configuration.qualification.owner.version ||
            !equal(owned.contribution.grammar, scope.grammar) ||
            typeof owned.inspectContext !== "function"
          )
            throw new TypeError("Live catalog services differ from the registered target or owner");
          const captured = await input.cache.lookupContext(scope);
          base = parseQueryContractContext(await abortable(owned.inspectContext(signal), signal));
          assertContextScope(base, scope);
          if (configuration.context && !equal(configuration.context, base)) {
            base = configuration.context;
            throw new CatalogContextChangedError("Pinned catalog context differs from the native target");
          }
          const previous = input.recordedProjectCatalogs?.baseContext ?? input.recordedContext;
          const observed = await input.cache.publishContext({
            token: captured.token,
            scope,
            context: base,
            ...(previous ? { previousContext: previous } : {}),
          });
          if (observed.status !== "published") throw new Error(`Base catalog context selection ${observed.status}`);
          const baseToken: AnalysisCacheToken = observed.token;
          const acquired = await abortable(
            acquireNativeProjectCatalog({
              adapter: owned.adapter,
              sql: input.candidates.map((candidate) => candidate.sql),
              context: base,
              signal,
            }),
            signal,
          );
          signal.throwIfAborted();
          if (acquired.status !== "acquired") {
            if (acquired.reason === "context-mismatch" || acquired.reason === "context-changed")
              throw new CatalogContextChangedError("Database context changed during selected catalog capture");
            throw new Error(`Selected catalog capture is unavailable (${acquired.reason})`);
          }
          const contributions = await abortable(
            Promise.resolve().then(() => projectCatalogs.loadContributions()),
            signal,
          );
          closure = createProjectCatalogClosure({
            schema: input.schema,
            context: base,
            typePolicy: policy,
            catalogs: [acquired.catalog],
            contributions,
          });
          const projected = materializeProjectCatalogClosure({
            closure,
            schema: input.schema,
            typePolicy: policy,
            contributions,
          });
          const services = owned;
          const current = async (active?: AbortSignal): Promise<QueryContractContext> => {
            const context = parseQueryContractContext(
              await abortable(services.inspectContext(active ?? signal), active ?? signal),
            );
            assertContextScope(context, scope);
            if (!equal(context, base))
              throw new CatalogContextChangedError("Selected catalog context changed before query qualification");
            return closure!.context;
          };
          const adapter: NativeContractAdapter = {
            id: services.adapter.id,
            version: services.adapter.version,
            grammar: services.adapter.grammar,
            ...(services.adapter.classifyError
              ? { classifyError: services.adapter.classifyError.bind(services.adapter) }
              : {}),
            accept: (candidate) => services.adapter.accept(candidate),
            async open(active) {
              const boundary = active ?? signal;
              let received = false;
              const opening = Promise.resolve().then(() => {
                boundary.throwIfAborted();
                return services.adapter.open(boundary);
              });
              void opening
                .then(async (session) => {
                  if (boundary.aborted && !received) await session.close();
                })
                .catch(() => {});
              const session = await abortable(opening, boundary);
              received = true;
              return {
                async context(sessionSignal) {
                  const context = parseQueryContractContext(
                    await abortable(session.context(sessionSignal), sessionSignal ?? boundary),
                  );
                  assertContextScope(context, scope);
                  if (!equal(context, base))
                    throw new CatalogContextChangedError("Selected catalog context changed during query qualification");
                  return closure!.context;
                },
                describe: (candidate, sessionSignal) =>
                  abortable(session.describe(candidate, sessionSignal), sessionSignal ?? boundary),
                close: () =>
                  abortable(
                    Promise.resolve().then(() => session.close()),
                    boundary,
                  ),
              };
            },
          };
          const { context: _context, ...automatic } = configuration;
          const effective = defineAnalysisConfiguration({
            ...automatic,
            identity: {
              profileHash: closure.context.profileHash,
              codecHash: closure.context.codecHash,
              interpreterHash: closure.context.interpreterHash,
            },
            ...(configuration.context ? { context: closure.context } : {}),
          });
          const {
            projectCatalogs: _catalogs,
            recordedProjectCatalogs: _recordedCatalogs,
            recordedContext: _recorded,
            ...rest
          } = input;
          const view = await prepare({
            ...rest,
            loadAnalyzer: () =>
              abortable(
                Promise.resolve().then(() => input.loadAnalyzer()),
                signal,
              ),
            schema: projected.schema,
            configuration: effective,
            signal,
            live: {
              ...live,
              adapter: () => ({
                connectionContext: services.connectionContext,
                contribution: services.contribution,
                ...(services.classifyError ? { classifyError: services.classifyError.bind(services) } : {}),
                adapter,
                inspectContext: current,
                close: async () => {},
              }),
            },
          });
          await current(signal);
          signal.throwIfAborted();
          if (!(await input.cache.areTokensCurrent([baseToken])))
            throw new Error("Base catalog context changed before publication");
          return Object.freeze({
            ...view,
            schema: projected.schema,
            projectCatalogs: closure,
            async assertCurrent() {
              await view.assertCurrent();
              if (!(await input.cache.areTokensCurrent([baseToken])))
                throw new Error("Base catalog context changed before publication");
            },
          });
        })(),
      ]);
      const [cleanup] = await Promise.allSettled([
        owned && typeof owned.close === "function" ? abortable(close(owned), signal) : undefined,
      ]);
      if (cleanup.status === "rejected") {
        if (operation.status === "rejected")
          throw new AggregateError([operation.reason, cleanup.reason], "Catalog capture and cleanup failed");
        throw cleanup.reason;
      }
      if (operation.status === "fulfilled") return operation.value;
      if (operation.reason instanceof CatalogContextChangedError) {
        if (base) await input.cache.retireContext(base);
        if (closure) await input.cache.retireContext(closure.context);
        signal.throwIfAborted();
        if (!configuration.context && attempt < 2) continue;
      }
      throw operation.reason;
    }
  } finally {
    clearTimeout(timer);
  }
}
