/** Source-derived arity overlays reviewed semantic families; it does not invent return rules. */
export function projectRoutines(families, profiles) {
  const routines = [],
    report = [];
  for (const family of families) {
    const buckets = new Map();
    for (const name of family.routines) {
      const registrations = profiles.map((profile) => profile.functions.find((row) => row.name === name)),
        qualified =
          registrations.length > 0 &&
          registrations.every((row) => row && !row.conditions.length && row.internal === false && row.minimum !== null);
      const minima = qualified ? [...new Set(registrations.map((row) => row.minimum))] : [],
        maxima = qualified ? [...new Set(registrations.map((row) => row.maximum))] : [],
        minimumArguments = minima.length === 1 ? minima[0] : family.minimumArguments,
        maximumArguments = maxima.length === 1 && maxima[0] !== null ? maxima[0] : family.maximumArguments;
      if (minima.length > 1 || maxima.length > 1)
        throw new TypeError(`Conflicting MySQL source arity within catalog band: ${name}`);
      if (maximumArguments !== null && maximumArguments < minimumArguments)
        throw new TypeError(`Conflicting MySQL source/policy arity: ${name}`);
      const key = JSON.stringify([minimumArguments, maximumArguments]),
        bucket = buckets.get(key) ?? { ...family, routines: [], minimumArguments, maximumArguments };
      bucket.routines.push(name);
      buckets.set(key, bucket);
      report.push({
        name,
        semanticRule: family.result,
        semanticSource: "maintained grammar policy",
        minimumArguments,
        maximumArguments,
        minimumSource: minima.length === 1 ? "vendor-registration" : "maintained-policy",
        maximumSource: maxima.length === 1 && maxima[0] !== null ? "vendor-registration" : "maintained-policy",
        registrations: profiles.flatMap((profile, index) =>
          registrations[index] ? [{ version: profile.version, ...registrations[index] }] : [],
        ),
      });
    }
    for (const bucket of buckets.values())
      routines.push({
        ...bucket,
        name:
          buckets.size === 1
            ? family.name
            : `${family.name}-${bucket.minimumArguments}-${bucket.maximumArguments ?? "open"}`,
        routines: bucket.routines.sort(),
      });
  }
  if (new Set(routines.map(({ name }) => name)).size !== routines.length)
    throw new TypeError("Duplicate generated MySQL routine family identity");
  return {
    routines: routines.sort((a, b) => a.name.localeCompare(b.name)),
    report: report.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
