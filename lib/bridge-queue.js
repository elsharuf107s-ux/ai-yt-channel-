import crypto from 'node:crypto';

const abortError = () => Object.assign(new Error('Stopped'), { name: 'AbortError' });

/**
 * Hand-off between the agent (in the Codespace) and the local bridge (on the user's computer).
 * The bridge polls: it sends heartbeats and claims one browser task at a time. A task that the
 * bridge claimed is never re-run automatically, because a click is not safe to repeat.
 */
export function createBridgeQueue({ now = () => Date.now(), onlineWindowMs = 10_000, taskTimeoutMs = 90_000 } = {}) {
  let bridge = null;
  const tasks = new Map();

  function status() {
    const online = Boolean(bridge) && now() - bridge.lastSeenAt <= onlineWindowMs;
    return { online, bridgeId: bridge?.bridgeId ?? null, mode: bridge?.mode ?? null, version: bridge?.version ?? null, lastSeenAt: bridge?.lastSeenAt ?? null };
  }

  function heartbeat({ bridgeId, mode, version } = {}) {
    bridge = {
      bridgeId: String(bridgeId || 'bridge').slice(0, 60),
      mode: String(mode || '').slice(0, 40),
      version: String(version || '').slice(0, 20),
      lastSeenAt: now()
    };
    return status();
  }

  function enqueue(action, { signal, timeoutMs = taskTimeoutMs } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (!status().online) {
      return Promise.reject(new Error('The local browser bridge is offline. Start it on your computer first (setup steps are in the Live browser panel).'));
    }
    return new Promise((resolve, reject) => {
      const task = { id: crypto.randomUUID(), action, status: 'queued', createdAt: now(), settle: null };
      const finish = (error, value) => {
        if (!tasks.delete(task.id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(
        () => finish(new Error(`The browser did not finish "${action.tool}" within ${Math.round(timeoutMs / 1000)}s.`)),
        timeoutMs
      );
      const onAbort = () => finish(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      task.settle = finish;
      tasks.set(task.id, task);
    });
  }

  /** Oldest queued task, or null. Counts as a heartbeat. */
  function claim(info = {}) {
    heartbeat({ bridgeId: info.bridgeId ?? bridge?.bridgeId, mode: info.mode ?? bridge?.mode, version: info.version ?? bridge?.version });
    for (const task of tasks.values()) {
      if (task.status === 'queued') {
        task.status = 'running';
        return { id: task.id, action: task.action };
      }
    }
    return null;
  }

  function complete(id, { ok, result, error } = {}) {
    const task = tasks.get(id);
    if (!task || task.status !== 'running') return false;
    if (ok) task.settle(null, result);
    else task.settle(new Error(String(error || 'The browser action failed.').slice(0, 1000)));
    return true;
  }

  return { status, heartbeat, enqueue, claim, complete };
}
