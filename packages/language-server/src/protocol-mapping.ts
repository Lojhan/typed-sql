interface Position {
  readonly line: number;
  readonly character: number;
}

interface CoordinateMapper<State> {
  readonly lookup: (uri: string) => State | undefined;
  readonly position: (state: State, position: Position) => Position;
  readonly version?: (state: State, version: number) => number;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Map protocol coordinates, respecting cross-file ownership and opaque data. */
export function mapProtocolCoordinates<State>(
  value: unknown,
  mapper: CoordinateMapper<State>,
  fallback?: State,
): unknown {
  if (Array.isArray(value)) return value.map((item) => mapProtocolCoordinates(item, mapper, fallback));
  if (!object(value)) return value;
  const uri =
    typeof value.uri === "string"
      ? value.uri
      : object(value.textDocument) && typeof value.textDocument.uri === "string"
        ? value.textDocument.uri
        : undefined;
  // An explicit unindexed URI is an identity mapping, never the caller's file.
  const state = uri === undefined ? fallback : mapper.lookup(uri);
  if (state !== undefined && typeof value.line === "number" && typeof value.character === "number") {
    return { ...value, ...mapper.position(state, { line: value.line, character: value.character }) };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      // Completion, code-action, hierarchy and diagnostic resolution data belongs
      // to its producer. It must survive the client/server round trip unchanged.
      if (key === "data") return [key, item];
      if (key === "textDocument" && object(item) && typeof item.uri === "string" && typeof item.version === "number") {
        const owner = mapper.lookup(item.uri);
        if (owner !== undefined && mapper.version !== undefined) {
          return [key, { ...item, version: mapper.version(owner, item.version) }];
        }
      }
      if (key === "changes" && object(item)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(item).map(([targetUri, edits]) => [
              targetUri,
              mapProtocolCoordinates(edits, mapper, mapper.lookup(targetUri)),
            ]),
          ),
        ];
      }
      const target =
        (key === "targetRange" || key === "targetSelectionRange") && typeof value.targetUri === "string"
          ? mapper.lookup(value.targetUri)
          : state;
      return [key, mapProtocolCoordinates(item, mapper, target)];
    }),
  );
}
