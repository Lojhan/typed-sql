import { defineLoader } from "vitepress";
import releaseManifest from "../../../release-manifest.json";

function shortPackageName(packageName: string): string {
  return packageName.replace(/^@typed-sql\//u, "");
}

export default defineLoader({
  load() {
    return {
      stable: releaseManifest.packagePolicy.stable.map(shortPackageName),
      experimental: releaseManifest.packagePolicy.experimental.map(shortPackageName),
    };
  },
});
