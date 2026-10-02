/**
 * relay/lib/task-runner.mjs — Queue-based task execution with retry
 *
 * Features:
 *   - In-memory task queue with configurable concurrency
 *   - Automatic retry with exponential backoff
 *   - Task timeout protection
 *   - Event hooks: onStart, onComplete, onError, onRetry
 *   - Full telemetry for monitoring
 */

/**
 * Create a new task runner instance
 */
export function createTaskRunner(options = {}) {
  const {
    maxConcurrency = 3,
    defaultRetries = 2,
    defaultTimeout = 90000,
    retryDelay = 1000,
    maxRetryDelay = 30000,
  } = options;

  const queue = [];
  let running = 0;
  let completed = 0;
  let failed = 0;
  let total = 0;
  const tasks = new Map(); // taskId -> task info
  const hooks = {};

  /**
   * Register a hook callback
   */
  function on(event, callback) {
    if (!hooks[event]) hooks[event] = [];
    hooks[event].push(callback);
  }

  /**
   * Emit an event to all registered hooks
   */
  function emit(event, data) {
    if (hooks[event]) {
      for (const cb of hooks[event]) {
        try { cb(data); } catch (e) { console.error(`[task-runner] Hook error (${event}):`, e.message); }
      }
    }
  }

  /**
   * Add a task to the queue
   */
  function addTask(name, handler, taskOptions = {}) {
    const id = `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const task = {
      id,
      name,
      handler,
      retries: taskOptions.retries ?? defaultRetries,
      retryCount: 0,
      timeout: taskOptions.timeout ?? defaultTimeout,
      priority: taskOptions.priority ?? 0,
      metadata: taskOptions.metadata || {},
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      status: 'queued',
      error: null,
      result: null,
    };

    tasks.set(id, task);
    total++;

    // Insert sorted by priority (higher = first)
    const insertIdx = queue.findIndex(t => t.priority < task.priority);
    if (insertIdx === -1) queue.push(task);
    else queue.splice(insertIdx, 0, task);

    processQueue();
    return id;
  }

  /**
   * Process the queue — start pending tasks up to maxConcurrency
   */
  function processQueue() {
    while (running < maxConcurrency && queue.length > 0) {
      const task = queue.shift();
      executeTask(task);
    }
  }

  /**
   * Execute a single task with timeout and retry
   */
  async function executeTask(task) {
    running++;
    task.status = 'running';
    task.startedAt = Date.now();

    emit('start', { id: task.id, name: task.name, metadata: task.metadata });

    const executeWithTimeout = async () => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Task "${task.name}" timed out after ${task.timeout}ms`));
        }, task.timeout);

        Promise.resolve()
          .then(() => task.handler(task))
          .then((result) => {
            clearTimeout(timer);
            resolve(result);
          })
          .catch((err) => {
            clearTimeout(timer);
            reject(err);
          });
      });
    };

    try {
      const result = await executeWithTimeout();
      task.status = 'completed';
      task.completedAt = Date.now();
      task.result = result;
      completed++;

      emit('complete', { id: task.id, name: task.name, result, duration: task.completedAt - task.startedAt });
    } catch (err) {
      task.error = err;

      if (task.retryCount < task.retries) {
        task.retryCount++;
        task.status = 'retrying';
        const delay = Math.min(retryDelay * Math.pow(2, task.retryCount - 1), maxRetryDelay);

        emit('retry', { id: task.id, name: task.name, attempt: task.retryCount, maxRetries: task.retries, delay, error: err.message });

        running--; // release slot before re-scheduling
        setTimeout(() => {
          executeTask(task);
        }, delay);
      } else {
        task.status = 'failed';
        task.completedAt = Date.now();
        failed++;

        emit('error', { id: task.id, name: task.name, error: err.message, retries: task.retryCount });
      }
    } finally {
      if (task.status !== 'retrying') {
        running--;
        processQueue();
      }
    }
  }

  /**
   * Get task status by ID
   */
  function getTask(id) {
    return tasks.get(id) || null;
  }

  /**
   * Get summary statistics
   */
  function getStats() {
    return {
      queueLength: queue.length,
      running,
      completed,
      failed,
      total,
      tasks: Array.from(tasks.values()).map(t => ({
        id: t.id,
        name: t.name,
        status: t.status,
        retryCount: t.retryCount,
        duration: t.completedAt && t.startedAt ? t.completedAt - t.startedAt : null,
        error: t.error?.message || null,
      })),
    };
  }

  /**
   * Wait for all tasks to complete
   */
  function waitForAll() {
    return new Promise((resolve) => {
      const check = () => {
        if (queue.length === 0 && running === 0 && ![...tasks.values()].some(t => t.status === 'retrying')) {
          resolve(getStats());
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  return {
    addTask,
    getTask,
    getStats,
    waitForAll,
    on,
  };
}

export default { createTaskRunner };
