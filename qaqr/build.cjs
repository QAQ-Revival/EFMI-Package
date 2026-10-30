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
  let commit = changes.reviewedUpstream;
  try { commit = git(['merge-base', 'HEAD', 'refs/remotes/upstream/main']); } catch { /* no upstream remote in this checkout */ }
  const blob = relative => {
    const command = spawnSync('git', ['cat-file', 'blob', `${commit}:EFMI/${relative}`], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return command.status ? null : command.stdout;
  };
  const version = coreVersion(blob('Core/EFMI/main.ini').toString('utf8'));
  if (version !== coreVersion(fs.readFileSync(path.join(root, 'EFMI/Core/EFMI/main.ini'), 'utf8'))) throw Error('EFMI baseline ' + commit + ' is behind the fork; update reviewedUpstream');
  const files = [];
  for (const relative of Object.keys(changes.compatibleFiles)) {
    const bytes = blob(relative);
    if (!bytes) continue;
    const destination = path.join(output, 'official', relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    // Releases ship CRLF; the repository stores LF.
    fs.writeFileSync(destination, bytes.toString('utf8').replace(/\r?\n/g, '\r\n'));
    files.push(relative);
  }
  return { version, commit, files };
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
  fs.writeFileSync(path.join(output, 'component.json'), JSON.stringify({ source: 'https://github.com/QAQ-Revival/EFMI-Package', sourceCommit: git(['rev-parse', 'HEAD']), validation: 'D3D11 WARP', gameRuntimeValidated: false, compatibleFiles: require('./changes.json').compatibleFiles, official, files: listFiles(output) }, null, 2));
  return output;
}
if (require.main === module) build({ verifyOnly: process.argv.includes('--verify-only') });
module.exports = { build, writeOfficial, listFiles };
