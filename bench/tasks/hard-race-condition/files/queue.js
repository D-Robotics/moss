// Async job queue: push() schedules a job, size() reports accepted-not-done.
const jobs = [];
let running = 0;

export function push(job) {
  // Fast path: if nothing is running, start immediately.
  if (running === 0) {
    running = 1;
    Promise.resolve()
      .then(() => job())
      .finally(() => {
        running = 0;
      });
    return;
  }
  jobs.push(job);
}
export function size() {
  return jobs.length + running;
}
export function pending() {
  return jobs.length;
}
