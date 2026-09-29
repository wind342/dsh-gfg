import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// Optional argument: installed official @deepseek-ai/dsh/lib/bin.js.
// All profile writes stay under this ignored, isolated directory.
const root = resolve('.profile-smoke');
mkdirSync(root, { recursive: true });
const home = mkdtempSync(join(root, 'home-'));
const profile = join(home, 'profiles', 'gfg-smoke');
mkdirSync(profile, { recursive: true });
const cli = resolve(process.argv[2] ?? '.profile-smoke/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
const report = { product_cli_profile_test: false, pack: false, profile_install: false, bundle_enabled: false, dump_config: false, plugin_started: false };
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const inputs = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'README.md',
  'examples/profile-install-smoke.mjs', 'examples/profile-smoke-probe.mjs', ...files('src')];
report.tested_source_sha256 = Object.fromEntries(inputs.map(path => [path.replaceAll('\\', '/'), createHash('sha256').update(readFileSync(path)).digest('hex')]));
let stage = 'pack';
function command(command, args, env) {
  const run = spawnSync(command, args, { encoding: 'utf8', env, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  // Detailed logs stay local: they may contain machine paths.
  writeFileSync(join(home, `${stage}.log`), `${run.stdout ?? ''}\n${run.stderr ?? ''}`);
  if (run.error || run.status !== 0) throw new Error(`${stage}: ${run.error?.code ?? `exit ${run.status}`}`);
  return run.stdout;
}
try {
  const env = { ...process.env, DSH_HOME: home, NO_COLOR: '1' };
  if (process.platform === 'win32') command(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm pack'], env);
  else command('pnpm', ['pack'], env);
  report.pack = true;
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const tarball = resolve(`${pkg.name}-${pkg.version}.tgz`);
  report.tarball_sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  stage = 'cli_available';
  assert.ok(existsSync(cli), 'Install official CLI separately or supply its bin.js path');
  report.cli_version = command(process.execPath, [cli, '--version'], env).trim();
  report.platform = process.platform;
  report.node_version = process.version;
  // A minimal user profile: only plugin dependencies, no model provider or agent.
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'gfg-smoke-profile', private: true, dsh: { profile: { bundles: [] } } }));
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nminimumReleaseAge: 0\n');
  copyFileSync('examples/profile-smoke-probe.mjs', join(profile, 'probe.mjs'));
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { insert: [
      { id: 'llm', name: '@deepseek-ai/dsh-llm' },
      { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
      { id: 'session', name: '@deepseek-ai/dsh-session' },
      { id: 'tools', name: '@deepseek-ai/dsh-tools' },
      { id: 'smoke-probe', name: join(profile, 'probe.mjs') },
    ] },
    { id: 'dsh-gfg', config: { directory: join(home, 'private-gfg') } },
  ]));
  stage = 'profile_install';
  command(process.execPath, [cli, 'plugin', '--profile', 'gfg-smoke', 'add', tarball], env);
  report.profile_install = true;
  const installed = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
  assert.ok(installed.dsh.profile.bundles.includes('dsh-gfg'));
  report.bundle_enabled = true;
  stage = 'dump_config';
  const config = command(process.execPath, [cli, '--profile', 'gfg-smoke', '--dump-config'], env);
  assert.match(config, /dsh-gfg/);
  report.dump_config = true;
  stage = 'startup';
  const output = command(process.execPath, [cli, '--profile', 'gfg-smoke'], env);
  assert.match(output, /DSH_GFG_PROFILE_SMOKE \{"plugin_started":true\}/);
  report.plugin_started = true;
  report.product_cli_profile_test = true;
} catch (error) {
  report.failure_stage = stage;
  report.failure = String(error.message);
  process.exitCode = 1;
}
writeFileSync('artifacts/PROFILE_INSTALL_SMOKE.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
