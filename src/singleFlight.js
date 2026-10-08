// -----------------------------------------------------------------------------
// Single-flight: at most one run of a task at a time, the concurrent requests
// coalesced into one follow-up run.
//
// The publish pass is asked for from everywhere — the watchdog tick, the
// Gladys reconnection, the inventory debounce, the device-created debounce,
// the configuration update, the "refresh" button — and nothing used to stop
// two of them from interleaving: two passes reading the publisher's dedupe map
// at the same time send the same states twice (spending the rate budget) and
// can fire the same scene event twice, since both diff the verdicts before
// either has recorded them.
//
// A request arriving while a run is in progress does not start a second one,
// and does not ride on the current one either (it may have read the monitor
// before what the caller wants published happened): it waits for ONE trailing
// run that starts once the current one is over, shared by every request that
// arrived in the meantime.
// -----------------------------------------------------------------------------

/**
 * Wrap a task so its runs never overlap.
 * @template T
 * @param {() => Promise<T>} task - The task to run.
 * @returns {() => Promise<T>} Runs the task, or joins the next run when one is in progress.
 */
export function singleFlight(task) {
  let running = null;
  let queued = null;

  const run = () => {
    if (!running) {
      running = Promise.resolve()
        .then(task)
        .finally(() => {
          running = null;
        });
      return running;
    }
    if (!queued) {
      // A failed run must not fail the requests queued behind it: they asked
      // for a run of their own.
      queued = running
        .catch(() => {})
        .then(() => {
          queued = null;
          return run();
        });
    }
    return queued;
  };

  return run;
}
