import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAction, needsApproval, isSafeShell, isPrivateHost } from '../lib/policy.js';
import { validateAction } from '../lib/tools.js';

const level = (tool, args, ctx) => assessAction(tool, args, ctx).level;
const elements = (...list) => new Map(list.map((el) => [el.id, el]));

test('read-only shell commands are safe, everything else is risky', () => {
  for (const command of ['ls', 'ls -la', 'pwd', 'cat notes.txt', 'git status', 'git log --oneline', 'node --version', 'echo hello', 'grep -rn todo src', 'head -n 5 out.log']) {
    assert.equal(isSafeShell(command), true, command);
  }
  for (const command of ['touch a.txt', 'rm file', 'npm install', 'curl https://x.com', 'python3 run.py', 'git push', 'git commit -m x', 'node script.js', 'npm test']) {
    assert.equal(isSafeShell(command), false, command);
  }
});

test('shell metacharacters, secrets and path escapes make an allowlisted command risky', () => {
  for (const command of [
    'ls; rm -rf x', 'ls && touch x', 'cat a | sh', 'echo hi > file', 'echo $(whoami)', 'echo `id`', 'cat /etc/passwd', 'cat ../secret',
    'cat data/config.json', 'cat .env', 'cat ~/.ssh/id_rsa', 'cat /proc/self/environ', 'git diff --output=x', 'ls\ntouch x', 'node -e 1'
  ]) {
    assert.equal(isSafeShell(command), false, JSON.stringify(command));
  }
});

test('catastrophic commands are blocked in every mode', () => {
  for (const command of ['rm -rf /', 'rm -rf ~', 'rm -fr /*', 'sudo rm -rf / --no-preserve-root', 'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/sda', ':(){ :|:& };:', 'shutdown now', 'rm -rf .']) {
    const assessment = assessAction('shell', { command });
    assert.equal(assessment.level, 'blocked', command);
    assert.equal(needsApproval(assessment, 'shell', 'auto'), false);
  }
  assert.equal(level('shell', { command: 'rm -rf build' }), 'risky');
});

test('goto: public pages are safe, private networks need approval, odd schemes are blocked', () => {
  assert.equal(level('goto', { url: 'https://example.com/path' }), 'safe');
  assert.equal(level('goto', { url: 'http://localhost:3000' }), 'risky');
  assert.equal(level('goto', { url: 'http://192.168.1.1/admin' }), 'risky');
  assert.equal(level('goto', { url: 'http://169.254.169.254/latest' }), 'risky');
  assert.equal(level('goto', { url: 'http://2130706433/' }), 'risky');
  assert.equal(level('goto', { url: 'http://[::1]:8080/' }), 'risky');
  assert.equal(level('goto', { url: 'http://nas/' }), 'risky');
  assert.equal(level('goto', { url: 'file:///etc/passwd' }), 'blocked');
  assert.equal(level('goto', { url: 'javascript:alert(1)' }), 'blocked');
  assert.equal(level('goto', { url: 'chrome://settings' }), 'blocked');
  assert.equal(level('goto', { url: 'not a url' }), 'blocked');
});

test('private host detection', () => {
  for (const host of ['localhost', 'a.localhost', 'printer.local', '10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.0.1', '127.0.0.1', '100.64.0.1', '0.0.0.0', 'router']) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '100.63.0.1', 'sub.domain.co.uk']) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test('clicks on buttons that buy, send, post or delete need approval', () => {
  const ctx = {
    elements: elements(
      { id: 1, tag: 'button', label: 'Place order' },
      { id: 2, tag: 'button', label: 'Delete account' },
      { id: 3, tag: 'a', label: 'Read more' },
      { id: 4, tag: 'button', label: 'Search' },
      { id: 5, tag: 'button', label: 'Postal code help' },
      { id: 6, tag: 'input', type: 'submit', label: '', value: 'Send message' }
    )
  };
  assert.equal(level('click', { id: 1 }, ctx), 'risky');
  assert.equal(level('click', { id: 2 }, ctx), 'risky');
  assert.equal(level('click', { id: 3 }, ctx), 'safe');
  assert.equal(level('click', { id: 4 }, ctx), 'safe');
  assert.equal(level('click', { id: 5 }, ctx), 'safe');
  assert.equal(level('click', { id: 6 }, ctx), 'risky');
  assert.equal(level('click', { id: 99 }, ctx), 'safe');
});

test('typing into password and payment fields needs approval', () => {
  const ctx = {
    elements: elements(
      { id: 1, tag: 'input', type: 'password', label: 'Secret' },
      { id: 2, tag: 'input', type: 'text', label: 'Card number' },
      { id: 3, tag: 'input', type: 'text', label: 'Search' }
    )
  };
  assert.equal(level('type', { id: 1, text: 'x' }, ctx), 'risky');
  assert.equal(level('type', { id: 2, text: '4111' }, ctx), 'risky');
  assert.equal(level('type', { id: 3, text: 'cats' }, ctx), 'safe');
});

test('approval rules for each safety mode', () => {
  const safe = assessAction('goto', { url: 'https://example.com' });
  const risky = assessAction('shell', { command: 'touch x' });

  assert.equal(needsApproval(safe, 'goto', 'ask'), false);
  assert.equal(needsApproval(risky, 'shell', 'ask'), true);

  assert.equal(needsApproval(safe, 'goto', 'strict'), true);
  assert.equal(needsApproval(risky, 'shell', 'strict'), true);
  for (const tool of ['snapshot', 'wait', 'scroll', 'finish']) {
    assert.equal(needsApproval({ level: 'safe' }, tool, 'strict'), false, tool);
  }

  assert.equal(needsApproval(safe, 'goto', 'auto'), false);
  assert.equal(needsApproval(risky, 'shell', 'auto'), false);
});

test('validateAction normalises and rejects bad arguments', () => {
  assert.deepEqual(validateAction('click', { id: '12' }), { id: 12 });
  assert.deepEqual(validateAction('goto', { url: 'example.com' }), { url: 'https://example.com' });
  assert.deepEqual(validateAction('scroll', {}), { direction: 'down' });
  assert.deepEqual(validateAction('wait', { seconds: 9999 }), { seconds: 300 });
  assert.deepEqual(validateAction('type', { id: 1, text: 'hi', submit: 'true' }), { id: 1, text: 'hi', submit: true });
  assert.deepEqual(validateAction('click', { id: 3, extra: 'ignored' }), { id: 3 });
  assert.throws(() => validateAction('click', {}), /needs "id"/);
  assert.throws(() => validateAction('click', { id: 1.5 }), /whole number/);
  assert.throws(() => validateAction('scroll', { direction: 'sideways' }), /one of/);
  assert.throws(() => validateAction('press', { key: 'Enter; rm' }), /unsupported/);
  assert.throws(() => validateAction('shell', { command: 'x'.repeat(2001) }), /too long/);
  assert.throws(() => validateAction('format_disk', {}), /Unknown tool/);
});
