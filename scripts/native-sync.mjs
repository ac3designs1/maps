import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: true });
  if (r.status) process.exit(r.status);
}

run("node", ["scripts/make-icons.mjs"]);
run("node", ["scripts/write-cap-config.mjs"]);
run("npx", ["cap", "sync"]);
run("node", ["scripts/patch-native.mjs"]);
