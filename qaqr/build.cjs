const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const git = args => {
  const command = spawnSync('git', ['-c', 'user.name=qaq-revival-publisher[bot]', '-c', 'user.email=338412940+qaq-revival-publisher[bot]@users.noreply.github.com', '-c', 'credential.helper=', ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (command.status) throw Error('Cannot identify or archive EFMI source');
  return command.stdout.trim();
};
const coreVersion = text => {
  const match = /^global \$version = (\d+)\.(\d)(\d*)/m.exec(text);
  if (!match) throw Error('Cannot read the EFMI version');
  return `${match[1]}.${match[2]}.${match[3] || 0}`;
};

// QAQR restores these when the user picks the official files. The Launcher keeps no copy of EFMI,
// and whatever sits in an install may already be patched, so they come from the upstream commit.
function writeOfficial(output) {
  const changes = require('./changes.json');
  // The baseline is whatever upstream commit this fork last merged. A CI checkout has no upstream
  // remote, and a local one may be stale, so the branch is fetched here; offline, the last fetch serves.
  const upstream = 'refs/remotes/upstream/main';
  try { git(['fetch', '--no-tags', '--no-recurse-submodules', 'https://github.com/' + changes.upstream + '.git', '+refs/heads/main:' + upstream]); } catch { /* offline */ }
  const commit = git(['merge-base', 'HEAD', upstream]);
  const blob = relative => {
    const command = spawnSync('git', ['cat-file', 'blob', `${commit}:EFMI/${relative}`], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return command.status ? null : command.stdout;
  };
  // The 1.5.1 ZIP changed four files without advancing the source tag. The restored
  // files still come from that commit and must match the reviewed release byte for byte.
  const release = changes.officialRelease?.commit === commit ? changes.officialRelease : null;
  const version = release ? release.tag.slice(1) : coreVersion(blob('Core/EFMI/main.ini').toString('utf8'));
  if (version !== coreVersion(fs.readFileSync(path.join(root, 'EFMI/Core/EFMI/main.ini'), 'utf8'))) throw Error('EFMI baseline ' + commit + ' is behind the fork; the upstream branch could not be fetched');
  const files = [];
  for (const relative of Object.keys(changes.compatibleFiles)) {
    const source = blob(relative);
    const bytes = source && Buffer.from(source.toString('utf8').replace(/\r?\n/g, '\r\n'));
    if (release && release.files[relative] !== (bytes && crypto.createHash('sha256').update(bytes).digest('hex'))) {
      throw Error('Official EFMI file differs from the release: ' + relative);
    }
    if (!bytes) continue;
    const destination = path.join(output, 'official', relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    // Releases ship CRLF; the repository stores LF.
    fs.writeFileSync(destination, bytes);
    files.push(relative);
  }
  return { version, commit, ...(release ? { tag: release.tag, archiveSha256: release.archiveSha256 } : {}), files };
}

function listFiles(output) {
  const files = {};
  for (const entry of fs.readdirSync(output, { recursive: true, withFileTypes: true })) if (entry.isFile() && entry.name !== 'component.json') {
    const file = path.join(entry.parentPath, entry.name);
    files[path.relative(output, file).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return files;
}

function build({ output = path.join(root, 'build/component'), verifyOnly = false } = {}) {
  const work = path.join(root, 'build/checks');
  fs.mkdirSync(work, { recursive: true });
  const candidate = path.join(work, 'shader-' + crypto.randomUUID() + '.bin');
  const cacheRelative = 'Core/EFMI/Shaders/MergedSkeleton_InstanceConfigOverrider_ConstantBuffer.cs_5_0.8000.bin';
  const result = spawnSync(process.env.QAQR_PYTHON || 'python', [path.join(__dirname, 'validate_shader.py'), '--efmi-root', path.join(root, 'EFMI'), '--compiler', path.join(process.env.WINDIR || 'C:/Windows', 'System32/d3dcompiler_47.dll'), '--out-bin', candidate], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status) throw result.error || Error('EFMI shader WARP validation failed');
  if (verifyOnly) { fs.unlinkSync(candidate); return; }
  if (git(['status', '--porcelain', '--ignore-submodules=all'])) throw Error('Commit the reviewed EFMI source before packaging');
  output = path.resolve(output);
  fs.mkdirSync(output, { recursive: true });
  for (const relative of Object.keys(require('./changes.json').compatibleFiles)) {
    const destination = path.join(output, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(relative === cacheRelative ? candidate : path.join(root, 'EFMI', relative), destination);
  }
  fs.unlinkSync(candidate);
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
  git(['archive', '--format=zip', '--output=' + path.join(output, 'source.zip'), 'HEAD']);
  const official = writeOfficial(output);
  // QAQR numbers its build <upstream version>.<n>, n counting QAQR's own commits on top of that upstream release.
  const patches = git(['rev-list', '--count', '--no-merges', '--author=qaq-revival-publisher', `${official.commit}..HEAD`]);
  fs.writeFileSync(path.join(output, 'component.json'), JSON.stringify({ source: 'https://github.com/QAQ-Revival/EFMI-Package', sourceCommit: git(['rev-parse', 'HEAD']), version: `${official.version}.${patches}`, validation: 'D3D11 WARP', gameRuntimeValidated: false, compatibleFiles: require('./changes.json').compatibleFiles, official, files: listFiles(output) }, null, 2));
  return output;
}
if (require.main === module) build({ verifyOnly: process.argv.includes('--verify-only') });
module.exports = { build, writeOfficial, listFiles };
