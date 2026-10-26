#!/usr/bin/env node
// Installs llama.cpp's `llama-server` into bin/ so the app can run a GGUF model inside this machine.
// Uses the prebuilt release from github.com/ggml-org/llama.cpp. Linux and macOS only.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findLlamaServer } from '../lib/model-runner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';

/** The CPU build for this OS and architecture, e.g. llama-b1234-bin-ubuntu-x64.tar.gz. */
export function pickAsset(assets, { platform = process.platform, arch = process.arch } = {}) {
  const os = { linux: 'ubuntu', darwin: 'macos' }[platform];
  const cpu = { x64: 'x64', arm64: 'arm64' }[arch];
  if (!os || !cpu) return null;
  const pattern = new RegExp(`-bin-${os}-${cpu}\\.(tar\\.gz|zip)$`);
  return assets.find((asset) => pattern.test(asset.name)) || null;
}

export function extractArchive(archive, destDir, run = spawnSync) {
  fs.mkdirSync(destDir, { recursive: true });
  const result = archive.endsWith('.zip')
    ? run('unzip', ['-q', '-o', archive, '-d', destDir], { encoding: 'utf8' })
    : run('tar', ['-xzf', archive, '-C', destDir], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not unpack ${path.basename(archive)}: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
  }
}

export async function installLlama({ destDir = path.join(ROOT, 'bin'), fetchImpl = globalThis.fetch, platform, arch, log = console.log, run = spawnSync } = {}) {
  const existing = findLlamaServer({ binDir: destDir });
  if (existing) {
    log(`llama-server is already available: ${existing}`);
    return existing;
  }

  log('Looking up the latest llama.cpp release…');
  const response = await fetchImpl(RELEASE_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'ai-shell-setup' } });
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for the llama.cpp release list.`);
  const release = await response.json();
  const asset = pickAsset(release.assets || [], { platform, arch });
  if (!asset) {
    throw new Error(`No prebuilt llama.cpp for ${platform || process.platform}/${arch || process.arch} in release ${release.tag_name}. Build it from source (github.com/ggml-org/llama.cpp) and set LLAMA_SERVER to the llama-server path.`);
  }

  fs.mkdirSync(destDir, { recursive: true });
  const archive = path.join(destDir, asset.name);
  log(`Downloading ${asset.name} (${release.tag_name})…`);
  const download = await fetchImpl(asset.browser_download_url, { headers: { 'user-agent': 'ai-shell-setup' } });
  if (!download.ok || !download.body) throw new Error(`Download failed with HTTP ${download.status}.`);
  await pipeline(Readable.fromWeb(download.body), fs.createWriteStream(archive));

  const target = path.join(destDir, 'llama.cpp');
  fs.rmSync(target, { recursive: true, force: true });
  extractArchive(archive, target, run);
  fs.rmSync(archive, { force: true });

  const binary = findLlamaServer({ binDir: target });
  if (!binary) throw new Error('The download did not contain llama-server.');
  fs.chmodSync(binary, 0o755);

  const check = run(binary, ['--version'], { encoding: 'utf8', env: { ...process.env, LD_LIBRARY_PATH: path.dirname(binary) } });
  if (check.error || check.status !== 0) {
    throw new Error(`llama-server was installed but would not run: ${check.error?.message || (check.stderr || '').trim().split('\n').pop() || `exit ${check.status}`}`);
  }
  log(`Installed ${binary}`);
  log(String(check.stderr || check.stdout).trim().split('\n')[0]);
  return binary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  installLlama().catch((error) => {
    console.error(`setup:llama failed: ${error.message}`);
    process.exit(1);
  });
}
