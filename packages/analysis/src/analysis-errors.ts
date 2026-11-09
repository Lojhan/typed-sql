/** Fixed internal categories let hosts report a failure without exposing its SQL or driver message. */
export function namedAnalysisError(
  name:
    | "LiveContextPublicationError"
    | "LiveContextPinError"
    | "LiveQueryPublicationError"
    | "LiveViewInvalidatedError"
    | "LiveDocumentChangedError"
    | "RecordedContextStaleError"
    | "RecordedContextUnavailableError"
    | "RecordedCatalogChangedError"
    | "RecordedEvidenceChangedError",
  message: string,
): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
