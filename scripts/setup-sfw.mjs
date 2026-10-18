// Bootstrap only the pinned native sfw binary for subsequent GitHub Actions steps.
// Downloaded bytes are verified before executable permissions or PATH publication.
// Usage: node scripts/setup-sfw.mjs
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const VERSION = "v1.15.2";
const ASSETS = {
  "linux/x64": {
    name: "sfw-free-linux-x86_64",
    sha256: "fea8171808f9d913635c8f55fa70f7e72451cd38b0fca3d694e12ee1a9d7fc68",
    url: "https://github.com/SocketDev/sfw-free/releases/download/v1.15.2/sfw-free-linux-x86_64",
  },
  "darwin/arm64": {
    name: "sfw-free-macos-arm64",
    sha256: "28c4d14ed5db09e3a3e299c02036ddaa524c5c476cb28e32deac4f77091acacb",
    url: "https://github.com/SocketDev/sfw-free/releases/download/v1.15.2/sfw-free-macos-arm64",
  },
  "darwin/x64": {
    name: "sfw-free-macos-x86_64",
    sha256: "3abd6086098e6ad604a8814cd6a5d9e5dd8e64c2108583f9e85c12e08baa7a26",
    url: "https://github.com/SocketDev/sfw-free/releases/download/v1.15.2/sfw-free-macos-x86_64",
  },
  "win32/x64": {
    name: "sfw-free-windows-x86_64.exe",
    sha256: "8802ace1584212ed0361db6f4f12447f9f426b52c24eada54f7625910c3d5292",
    url: "https://github.com/SocketDev/sfw-free/releases/download/v1.15.2/sfw-free-windows-x86_64.exe",
  },
};

const platform = `${process.platform}/${process.arch}`;
const asset = ASSETS[platform];
if (!asset) throw new Error(`unsupported sfw platform: ${platform}`);

const runnerTemp = process.env.RUNNER_TEMP;
const githubPath = process.env.GITHUB_PATH;
if (!runnerTemp || !githubPath) {
  throw new Error("RUNNER_TEMP and GITHUB_PATH are required for sfw bootstrap");
}
if (/[\r\n]/.test(runnerTemp)) {
  throw new Error("RUNNER_TEMP must be a single-line path for GITHUB_PATH publication");
}

const directory = await mkdtemp(join(runnerTemp, "sfw-"));
const executable = join(directory, process.platform === "win32" ? "sfw.exe" : "sfw");
let digest;
try {
  const response = await fetch(asset.url);
  if (!response.ok) {
    throw new Error(`sfw ${VERSION} download failed: HTTP ${response.status} (${asset.name})`);
  }
  if (!response.body) throw new Error(`sfw download has no body: ${asset.name}`);

  const hash = createHash("sha256");
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({
      transform(chunk, encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(executable, { flags: "wx", mode: 0o600 }),
  );
  digest = hash.digest("hex");
  if (digest !== asset.sha256) {
    throw new Error(
      `sfw SHA256 mismatch for ${asset.name}: expected ${asset.sha256}, received ${digest}`,
    );
  }

  if (process.platform !== "win32") await chmod(executable, 0o700);
  await appendFile(githubPath, `${directory}\n`, "utf8");
} catch (error) {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "sfw bootstrap and owned-directory cleanup failed");
  }
  throw error;
}

console.log(`[setup-sfw] ${VERSION} ${asset.name} verified SHA256 ${digest}`);
