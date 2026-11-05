'use strict';

const transitions = {
  waiting: ['preparing', 'cancelled'], queued: ['preparing', 'cancelled'], interrupted: ['preparing', 'cancelled'],
  failed: ['preparing', 'cancelled'], cancelled: ['preparing'], preparing: ['running', 'failed', 'cancelled', 'interrupted'],
  running: ['done', 'failed', 'cancelled', 'interrupted'], done: []
};
const safeEventTypes = new Set(['item', 'progress', 'phase', 'verify', 'video-complete', 'video-error']);
const phases = new Set(['preparing', 'video', 'audio', 'download', 'merging', 'converting', 'finishing', 'verifying']);

function sanitizeTaskEvent(event) {
  if (!event || !safeEventTypes.has(event.type)) return { type: 'provider-event' };
  const safe = { type: event.type };
  if (typeof event.phase === 'string' && phases.has(event.phase)) safe.phase = event.phase;
  for (const key of ['percent', 'overall', 'received', 'size', 'current', 'total', 'index']) {
    if (Number.isFinite(event[key])) safe[key] = Math.max(0, event[key]);
  }
  if (typeof event.indeterminate === 'boolean') safe.indeterminate = event.indeterminate;
  return safe;
}

class TaskOrchestrator {
  constructor({ database, scheduler }) { this.database = database; this.scheduler = scheduler; }

  async execute(task, createJob, onEvent = () => {}) {
    let current = task.status || 'waiting';
    const transition = (status, extra = {}) => {
      if (!transitions[current]?.includes(status)) throw new Error(`Invalid task transition: ${current} → ${status}.`);
      const previous = current;
      current = status;
      task = { ...task, ...extra, status, updatedAt: new Date().toISOString() };
      this.database.recordTransition(task, `state-${status}`, { from: previous, to: status });
    };
    const persistEvent = (event) => {
      const clean = sanitizeTaskEvent(event);
      this.database.appendTaskEvent(task.id, clean.type, clean);
      onEvent(event);
    };

    try {
      transition('preparing');
      const result = await this.scheduler.run(task.id, async () => {
        const handle = await createJob(persistEvent);
        transition('running');
        return handle;
      });
      if (result?.status === 'completed') transition('done', { note: sanitizeError({ message: result.message || '' }), outFolder: result.folder || task.outFolder });
      else if (result?.status === 'cancelled') transition('cancelled', { note: result.message || 'Cancelled.' });
      else transition('failed', { note: result?.message || 'The provider failed the task.' });
      return result;
    } catch (error) {
      if (transitions[current]?.includes('failed')) transition('failed', { note: sanitizeError(error) });
      throw error;
    }
  }
}

function sanitizeError(error) {
  return String(error?.message || 'The task failed.').replace(/https?:\/\/\S+/gi, '[source URL]').replace(/[A-Za-z]:\\[^\s]+/g, '[local path]').slice(0, 400);
}

module.exports = { TaskOrchestrator, sanitizeTaskEvent, sanitizeError, transitions };
