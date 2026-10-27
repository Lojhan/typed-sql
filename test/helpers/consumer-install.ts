export function consumerInstallArgs(registryOnly: boolean): string[] {
  return [
    "install",
    ...(registryOnly ? ["--prefer-offline=false"] : ["--offline", "--ignore-scripts"]),
    "--no-frozen-lockfile",
  ];
}
