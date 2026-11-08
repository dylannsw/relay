// `npm run package`: builds the Windows installer, signed for the updater.
// Tauri signs update files with the private key from TAURI_SIGNING_PRIVATE_KEY. On this PC
// that's the key file in ~/.tauri; in GitHub Actions it comes from a repository secret.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyFile = join(homedir(), ".tauri", "relay.key");
  if (!existsSync(keyFile)) {
    console.error(`No update signing key found at ${keyFile}. See "Releasing updates" in README.md.`);
    process.exit(1);
  }
  env.TAURI_SIGNING_PRIVATE_KEY = keyFile;
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
}

const result = spawnSync("npx", ["tauri", "build", ...process.argv.slice(2)], { stdio: "inherit", env, shell: true });
process.exit(result.status ?? 1);
