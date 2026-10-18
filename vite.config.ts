import { execFileSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Build stamp. Emits dist/version.json after bundling. The commit is deliberately NOT
// injected into any JS/CSS/HTML, so asset hashes (and index.html) are identical for
// every commit and builds stay reproducible.
const SERVICE = 'yapture-app-standups';

function resolveBuildCommit(): string {
  const override = process.env.BUILD_COMMIT;
  if (override !== undefined && override !== '') {
    if (!/^[0-9a-f]{40}$/.test(override)) {
      throw new Error('BUILD_COMMIT must be a 40-character lowercase hex commit SHA');
    }
    return override;
  }
  // 'unstamped' is the same sentinel Market's release gates refuse. These apps ship as direct Pages uploads
  // of a local build, so a dirty tree (code that was never committed) must not be stamped as HEAD.
  const git = (args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const sha = git(['rev-parse', 'HEAD']);
    if (!/^[0-9a-f]{40}$/.test(sha)) return 'unstamped';
    return git(['status', '--porcelain']) === '' ? sha : 'unstamped';
  } catch {
    return 'unstamped';
  }
}

function buildStamp(): Plugin {
  return {
    name: 'yapture-build-stamp',
    apply: 'build', // the dev server has no /version.json (it answers with the app shell)
    generateBundle() {
      const stamp = {
        service: SERVICE,
        build_commit: resolveBuildCommit(),
        built_at: new Date().toISOString(),
      };
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(stamp, null, 2) + '\n' });
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), react(), buildStamp()],
  server: { port: 4752 },
});
