#!/usr/bin/env node
// Downloads a GGUF model from Hugging Face into models/ with the `hf` CLI, ready for the built-in runner.
//
//   npm run setup:model -- --include "*Q4_K_M*"
//   npm run setup:model -- --repo owner/name --include "*IQ3_XS*"
//
// A GGUF repo usually holds many quantizations, each tens of GB, so a quantization must be chosen.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPO = 'SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF';
const HF_INSTALL = 'curl -LsSf https://hf.co/cli/install.sh | bash';

export function parseArgs(argv) {
  const out = { repo: DEFAULT_REPO, include: '', all: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') out.repo = argv[++i] ?? '';
    else if (argv[i] === '--include') out.include = argv[++i] ?? '';
    else if (argv[i] === '--all') out.all = true;
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  if (!/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(out.repo)) throw new Error('--repo must look like owner/name.');
  if (out.include && !/^[\w*?.[\]-]{1,80}$/.test(out.include)) throw new Error('--include may only contain letters, digits and * ? . - _ [ ]');
  return out;
}

export function buildDownloadArgs({ repo, include, all }, modelsDir = path.join(ROOT, 'models')) {
  return ['download', repo, ...(include && !all ? ['--include', include] : []), '--local-dir', path.join(modelsDir, repo.split('/')[1])];
}

export function main(argv, { run = spawnSync, log = console.log, error = console.error } = {}) {
  let options;
  try { options = parseArgs(argv); } catch (e) { error(e.message); return 2; }

  if (!options.include && !options.all) {
    error([
      `${options.repo} probably holds several quantizations, each tens of GB, and the default Codespace disk is small.`,
      'Choose one with --include, for example:',
      '  npm run setup:model -- --include "*Q4_K_M*"',
      'or download everything on purpose with --all.'
    ].join('\n'));
    return 2;
  }

  const probe = run('hf', ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    error(`The "hf" command is not installed. Install it with:\n  ${HF_INSTALL}\nthen run this again.`);
    return 1;
  }

  const args = buildDownloadArgs(options);
  log(`hf ${args.join(' ')}`);
  const result = run('hf', args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    error('The download did not finish. It is safe to run the same command again: hf resumes where it stopped.');
    return result.status || 1;
  }
  log('Done. In AI Shell, choose Brain → Built-in model and press Start model.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
