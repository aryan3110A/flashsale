// Runs a k6 script with a local k6 binary if present, otherwise with the official grafana/k6 Docker image
// attached to the stack's network (so it talks to http://gateway:8080 directly).
//   node scripts/run-k6.mjs <script.js> [VAR=value ...]
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const [script, ...envPairs] = process.argv.slice(2);
if (!script) { console.error('usage: node scripts/run-k6.mjs <script.js> [VAR=value ...]'); process.exit(2); }
const env = Object.fromEntries(envPairs.map((p) => p.split(/=(.*)/s).slice(0, 2)));
const root = resolve(import.meta.dirname, '..');

const local = spawnSync('k6', ['version'], { shell: true, stdio: 'ignore' });
let res;
if (local.status === 0) {
  const args = ['run', '--quiet', ...Object.entries({ BASE_URL: 'http://localhost:8080', ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]), `load-tests/${script}`];
  res = spawnSync('k6', args, { cwd: root, stdio: 'inherit', shell: true });
} else {
  const network = process.env.K6_NETWORK ?? 'flashsale-sd_edge';
  const envs = Object.entries({ BASE_URL: 'http://gateway:8080', RESULTS_DIR: '/results', ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  res = spawnSync('docker', ['run', '--rm', '--network', network, '-v', `${root}/load-tests:/scripts:ro`, '-v', `${root}/load-tests/results:/results`, ...envs, 'grafana/k6:latest', 'run', '--quiet', `/scripts/${script}`],
    { cwd: root, stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
}
process.exit(res.status ?? 1);
