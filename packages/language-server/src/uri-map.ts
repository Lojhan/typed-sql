import { fileURLToPath, pathToFileURL } from "node:url";

export function canonicalDocumentUri(uri: string, windows = process.platform === "win32"): string {
  if (!uri.startsWith("file:")) return uri;
  const file = fileURLToPath(uri, { windows });
  return pathToFileURL(windows ? file.toLowerCase() : file, { windows }).href;
}

/** Clients and filesystem preload can spell one Windows document differently. */
export class UriMap<Value> extends Map<string, Value> {
  override get(uri: string): Value | undefined {
    return super.get(canonicalDocumentUri(uri));
  }
  override has(uri: string): boolean {
    return super.has(canonicalDocumentUri(uri));
  }
  override set(uri: string, value: Value): this {
    return super.set(canonicalDocumentUri(uri), value);
  }
  override delete(uri: string): boolean {
    return super.delete(canonicalDocumentUri(uri));
  }
}
