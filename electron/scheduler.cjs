'use strict';

class TaskScheduler {
  constructor({ concurrency = 1 } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Concurrency must be between 1 and 8.');
    this.concurrency = concurrency;
    this.running = new Map();
  }

  has(id) { return this.running.has(id); }

  async run(id, createJob) {
    if (this.running.has(id)) throw new Error('This task is already running.');
    if (this.running.size >= this.concurrency) throw new Error('The download queue is at its active task limit.');
    const entry = { job: null, cancelled: false, cancel() { this.cancelled = true; this.job?.cancel(); } };
    this.running.set(id, entry);
    try {
      const job = await createJob();
      if (!job || !job.promise || typeof job.cancel !== 'function') throw new Error('Invalid provider job.');
      entry.job = job;
      if (entry.cancelled) job.cancel();
      return await job.promise;
    }
    finally { this.running.delete(id); }
  }

  cancel(id) {
    const job = id ? this.running.get(id) : this.running.values().next().value;
    if (!job) return false;
    job.cancel();
    return true;
  }

  cancelAll() { for (const job of this.running.values()) job.cancel(); }
}

module.exports = { TaskScheduler };
