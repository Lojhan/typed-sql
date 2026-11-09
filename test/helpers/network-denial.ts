import { writeFile } from "node:fs/promises";

/** Node-process network trap; this deliberately does not claim an OS network namespace. */
export async function writeNetworkDenialPreload(path: string, message: string, failOnAttempt = false): Promise<void> {
  await writeFile(
    path,
    `
import net from "node:net";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
const key = Symbol.for("typed-sql.test.networkAttempts");
globalThis[key] = 0;
const ipc = Symbol.for("typed-sql.test.deniedIpcAttempts");
globalThis[ipc] = 0;
const denied = () => { globalThis[key]++; throw new Error(${JSON.stringify(message)}); };
// Config loaders may probe a parent-process Unix socket. Deny that too, but do not
// misclassify local filesystem IPC as TCP/DNS/fetch traffic.
const deniedSocket = (...args) => {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const path = typeof first === "string" ? first : first?.path;
  const localPipe = String.fromCharCode(92,92,46,92)+"pipe"+String.fromCharCode(92);
  const localIpc = typeof path === "string" && (process.platform === "win32" ? path.startsWith(localPipe) : path.startsWith("/")) && !(typeof first === "object" && ("port" in first || "host" in first));
  if(localIpc) { globalThis[ipc]++; throw new Error(${JSON.stringify(message)}); }
  return denied();
};
net.Socket.prototype.connect = deniedSocket;
net.connect = deniedSocket; net.createConnection = deniedSocket;
for (const target of [dns, dns.promises]) {
  for (const name of Object.keys(target)) {
    if ((name.startsWith("lookup") || name.startsWith("resolve") || name === "reverse") && typeof target[name] === "function") target[name] = denied;
  }
}
globalThis.fetch = denied;
syncBuiltinESMExports();
${failOnAttempt ? 'process.on("exit", () => { if (globalThis[key] !== 0) { process.stderr.write("Unexpected network attempt\\n"); process.exitCode = 1; } });' : ""}
`,
  );
}
