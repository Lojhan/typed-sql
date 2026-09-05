import { describe, it, strict } from "poku";
import { extendTypeScriptCapabilities } from "../src/capabilities.js";

await describe("additive TypeScript LSP capabilities", async () => {
  await it("preserves upstream options and unrelated features without mutation", () => {
    const upstream = Object.freeze({
      completionProvider: Object.freeze({
        resolveProvider: true,
        triggerCharacters: Object.freeze(['"', "."]),
        allCommitCharacters: Object.freeze([";"]),
        completionItem: Object.freeze({ labelDetailsSupport: true }),
      }),
      codeActionProvider: Object.freeze({
        resolveProvider: true,
        codeActionKinds: Object.freeze(["refactor", "source.organizeImports"]),
      }),
      definitionProvider: Object.freeze({ workDoneProgress: true }),
      renameProvider: Object.freeze({ prepareProvider: true }),
      referencesProvider: true,
      documentFormattingProvider: true,
      semanticTokensProvider: Object.freeze({ full: { delta: true }, legend: { tokenTypes: [], tokenModifiers: [] } }),
      experimental: Object.freeze({ customTypeScriptFeature: true }),
    });
    const extended = extendTypeScriptCapabilities(upstream);
    strict.deepStrictEqual(extended, {
      ...upstream,
      codeActionProvider: {
        ...upstream.codeActionProvider,
        codeActionKinds: ["refactor", "source.organizeImports", "quickfix"],
      },
    });
    strict.notStrictEqual(extended.completionProvider, upstream.completionProvider);
    strict.deepStrictEqual(upstream.codeActionProvider.codeActionKinds, ["refactor", "source.organizeImports"]);
  });

  await it("adds SQL providers when upstream does not provide them", () => {
    const expected = {
      completionProvider: { triggerCharacters: ["."] },
      definitionProvider: true,
      codeActionProvider: true,
    };
    strict.deepStrictEqual(extendTypeScriptCapabilities(undefined), expected);
    strict.deepStrictEqual(
      extendTypeScriptCapabilities({ definitionProvider: false, codeActionProvider: false }),
      expected,
    );
  });

  await it("does not restrict unrestricted action kinds or duplicate quickfix", () => {
    strict.deepStrictEqual(
      extendTypeScriptCapabilities({ codeActionProvider: { resolveProvider: true } }).codeActionProvider,
      { resolveProvider: true },
    );
    strict.deepStrictEqual(
      extendTypeScriptCapabilities({ codeActionProvider: { codeActionKinds: ["quickfix"] } }).codeActionProvider,
      { codeActionKinds: ["quickfix"] },
    );
    strict.deepStrictEqual(
      extendTypeScriptCapabilities({ completionProvider: { triggerCharacters: ["@"] } }).completionProvider,
      { triggerCharacters: ["@", "."] },
    );
  });
});
