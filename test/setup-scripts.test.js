import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pickAsset, extractArchive, installLlama } from '../scripts/setup-llama.js';
import { parseArgs, buildDownloadArgs, main } from '../scripts/setup-model.js';
import { tmpDir } from './helpers.js';

const asset = (name) => ({ name, browser_download_url: `https://example.test/${name}` });
const ASSETS = [
  'llama-b9999-bin-ubuntu-vulkan-x64.tar.gz',
  'llama-b9999-bin-ubuntu-x64.tar.gz',
  'llama-b9999-bin-macos-arm64.tar.gz',
  'llama-b9999-bin-macos-x64.tar.gz',
  'llama-b9999-bin-win-cpu-x64.zip',
  'cudart-llama-bin-win-cuda-12.4-x64.zip'
].map(asset);

function fakeRelease() {
  const src = tmpDir('release-src-');
  fs.mkdirSync(path.join(src, 'build', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(src, 'build', 'bin', 'llama-server'), '#!/bin/sh\necho "version: 9999 (fake)" >&2\n', { mode: 0o644 });
  fs.writeFileSync(path.join(src, 'build', 'bin', 'libggml.so'), 'x');
  const tarball = path.join(tmpDir('release-'), 'llama-b9999-bin-ubuntu-x64.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', tarball, '-C', src, 'build']).status, 0);
  return tarball;
}

test('picks the plain CPU build for this platform', () => {
  assert.equal(pickAsset(ASSETS, { platform: 'linux', arch: 'x64' }).name, 'llama-b9999-bin-ubuntu-x64.tar.gz');
  assert.equal(pickAsset(ASSETS, { platform: 'darwin', arch: 'arm64' }).name, 'llama-b9999-bin-macos-arm64.tar.gz');
  assert.equal(pickAsset(ASSETS, { platform: 'darwin', arch: 'x64' }).name, 'llama-b9999-bin-macos-x64.tar.gz');
  assert.equal(pickAsset(ASSETS, { platform: 'win32', arch: 'x64' }), null);
  assert.equal(pickAsset(ASSETS, { platform: 'linux', arch: 'arm64' }), null);
  assert.equal(pickAsset([asset('llama-b1-bin-ubuntu-x64.zip')], { platform: 'linux', arch: 'x64' }).name, 'llama-b1-bin-ubuntu-x64.zip');
});

test('unpacks a release archive and reports a broken one', () => {
  const dest = tmpDir('unpack-');
  extractArchive(fakeRelease(), dest);
  assert.ok(fs.existsSync(path.join(dest, 'build', 'bin', 'llama-server')));
  const junk = path.join(tmpDir('junk-'), 'bad.tar.gz');
  fs.writeFileSync(junk, 'not an archive');
  assert.throws(() => extractArchive(junk, tmpDir('unpack-')), /Could not unpack bad\.tar\.gz/);
});

test('installs llama-server from the latest release, and skips the download when it is already there', async () => {
  const tarball = fakeRelease();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('api.github.com')) {
      return Response.json({ tag_name: 'b9999', assets: ASSETS.map((a) => (a.name.endsWith('ubuntu-x64.tar.gz') && !a.name.includes('vulkan') ? { ...a, browser_download_url: 'https://example.test/cpu' } : a)) });
    }
    return new Response(fs.readFileSync(tarball));
  };
  const destDir = tmpDir('bin-');
  const logs = [];
  const binary = await installLlama({ destDir, fetchImpl, platform: 'linux', arch: 'x64', log: (line) => logs.push(line) });
  assert.equal(path.basename(binary), 'llama-server');
  assert.ok(binary.startsWith(path.join(destDir, 'llama.cpp')));
  assert.equal(fs.statSync(binary).mode & 0o111, 0o111);
  assert.ok(logs.some((line) => /version: 9999/.test(line)));
  assert.equal(calls[1], 'https://example.test/cpu');
  assert.equal(fs.existsSync(path.join(destDir, 'llama-b9999-bin-ubuntu-x64.tar.gz')), false);

  const again = await installLlama({ destDir, fetchImpl: async () => { throw new Error('should not download'); }, log: () => {} });
  assert.equal(again, binary);
});

test('install failures say what to do next', async () => {
  const forbidden = async () => new Response('no', { status: 403 });
  await assert.rejects(installLlama({ destDir: tmpDir('bin-'), fetchImpl: forbidden, log: () => {} }), /GitHub answered HTTP 403/);

  const noAsset = async () => Response.json({ tag_name: 'b1', assets: [] });
  await assert.rejects(installLlama({ destDir: tmpDir('bin-'), fetchImpl: noAsset, platform: 'linux', arch: 'x64', log: () => {} }), /Build it from source.*LLAMA_SERVER/s);

  const empty = tmpDir('empty-');
  fs.mkdirSync(path.join(empty, 'x'));
  fs.writeFileSync(path.join(empty, 'x', 'readme.txt'), 'hi');
  const emptyTar = path.join(tmpDir('empty-tar-'), 'llama-b1-bin-ubuntu-x64.tar.gz');
  spawnSync('tar', ['-czf', emptyTar, '-C', empty, 'x']);
  const hollow = async (url) => (url.includes('api.github.com')
    ? Response.json({ tag_name: 'b1', assets: [asset('llama-b1-bin-ubuntu-x64.tar.gz')] })
    : new Response(fs.readFileSync(emptyTar)));
  await assert.rejects(installLlama({ destDir: tmpDir('bin-'), fetchImpl: hollow, platform: 'linux', arch: 'x64', log: () => {} }), /did not contain llama-server/);
});

test('model download arguments are built safely', () => {
  assert.deepEqual(parseArgs([]), { repo: 'SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF', include: '', all: false });
  assert.deepEqual(parseArgs(['--repo', 'a/b', '--include', '*Q4_K_M*']), { repo: 'a/b', include: '*Q4_K_M*', all: false });
  assert.throws(() => parseArgs(['--repo', 'nope']), /owner\/name/);
  assert.throws(() => parseArgs(['--include', '*; rm -rf /']), /may only contain/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/);

  const dir = path.join('/x', 'models');
  assert.deepEqual(buildDownloadArgs({ repo: 'a/b', include: '*Q4*', all: false }, dir), ['download', 'a/b', '--include', '*Q4*', '--local-dir', path.join(dir, 'b')]);
  assert.deepEqual(buildDownloadArgs({ repo: 'a/b', include: '', all: true }, dir), ['download', 'a/b', '--local-dir', path.join(dir, 'b')]);
});

test('setup:model refuses to pull every quantization by accident, and explains a missing hf CLI', () => {
  const out = [];
  const logger = { log: (m) => out.push(m), error: (m) => out.push(m) };
  const never = () => { throw new Error('must not run'); };

  assert.equal(main([], { ...logger, run: never }), 2);
  assert.match(out.join('\n'), /several quantizations.*--include.*--all/s);

  out.length = 0;
  const noHf = () => ({ error: Object.assign(new Error('spawn hf ENOENT'), { code: 'ENOENT' }) });
  assert.equal(main(['--include', '*Q4*'], { ...logger, run: noHf }), 1);
  assert.match(out.join('\n'), /curl -LsSf https:\/\/hf\.co\/cli\/install\.sh \| bash/);

  out.length = 0;
  assert.equal(main(['--repo', 'bad'], { ...logger, run: never }), 2);
});

test('setup:model runs hf download for the chosen quantization, and passes failures on', () => {
  const calls = [];
  const out = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0 }; };
  assert.equal(main(['--include', '*Q4_K_M*'], { run, log: (m) => out.push(m), error: (m) => out.push(m) }), 0);
  assert.deepEqual(calls[0], ['hf', '--version']);
  assert.deepEqual(calls[1].slice(0, 4), ['hf', 'download', 'SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF', '--include']);
  assert.match(calls[1].at(-1), /models[\\/]Qwen3\.8-Flash-Next-GSQ-RCO-abliterated-GGUF$/);
  assert.match(out.join('\n'), /Start model/);

  const failing = (cmd, args) => (args[0] === '--version' ? { status: 0 } : { status: 7 });
  out.length = 0;
  assert.equal(main(['--include', '*Q4*'], { run: failing, log: (m) => out.push(m), error: (m) => out.push(m) }), 7);
  assert.match(out.join('\n'), /safe to run the same command again/);
});
