import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareWorkspace } from "../../../test/editor-hub/workspace.mjs";

export async function prepareOverlayWorkspace(workspace, root, spec) {
  const settings = await prepareWorkspace(workspace, root, spec);
  await writeFile(
    join(workspace, ".vscode/settings.json"),
    JSON.stringify({
      "typedSql.serverPath": join(root, "packages/language-server/dist/packages/language-server/src/server.js"),
      ...Object.fromEntries(Object.entries(settings).map(([key, value]) => [`typedSql.${key}`, value])),
    }),
  );
}
