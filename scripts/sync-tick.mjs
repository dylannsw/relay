// `npm run sync:tick`: copies Tick's shared task code (../tick/shared/src) into src/tasks/tick.
//
// The to-do note format is defined once, in the Tick repo, and the Obsidian plugin, the Raycast
// extension and Relay all use that code. Relay keeps a copy because its release build on GitHub
// only checks out this repo. Never edit the copy: change Tick, then run this again.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(process.env.TICK_REPO ?? join(root, "..", "tick"), "shared", "src");
const target = join(root, "src", "tasks", "tick");

if (!existsSync(source)) {
  console.error(`Tick's shared code wasn't found at ${source}. Clone the tick repo next to relay, or set TICK_REPO.`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
const files = readdirSync(source).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
for (const file of files) {
  const header = `// Copied from tick/shared/src/${file} by scripts/sync-tick.mjs. Do not edit: change Tick, then run npm run sync:tick.\n`;
  writeFileSync(join(target, file), header + readFileSync(join(source, file), "utf8").replace(/\r\n/g, "\n"));
}
console.log(`Copied ${files.length} files from ${source} to src/tasks/tick.`);
