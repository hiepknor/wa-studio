import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
const studioRoot = resolve(workspaceRoot, "apps/studio");
const runtimeRoot = resolve(workspaceRoot, "services/runtime");
const targetTriple = execFileSync("rustc", ["--print", "host-tuple"], {
  encoding: "utf8",
}).trim();
const extension = process.platform === "win32" ? ".exe" : "";
const source = resolve(runtimeRoot, "dist", "desktop", `wa-runtime${extension}`);
const destination = resolve(
  studioRoot,
  "src-tauri",
  "binaries",
  `wa-runtime-${targetTriple}${extension}`,
);
const migrationSource = resolve(runtimeRoot, "migrations");
const migrationDestination = resolve(
  studioRoot,
  "src-tauri",
  "resources",
  "runtime-migrations",
);

execFileSync("npm", ["-w", "@wa/runtime", "run", "desktop:sidecar"], {
  cwd: workspaceRoot,
  stdio: "inherit",
});
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
if (process.platform !== "win32") chmodSync(destination, 0o755);
rmSync(migrationDestination, { force: true, recursive: true });
cpSync(migrationSource, migrationDestination, { recursive: true });

process.stdout.write(`Prepared WA Runtime sidecar and migrations for ${targetTriple}\n`);
