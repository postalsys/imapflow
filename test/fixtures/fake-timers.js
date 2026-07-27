'use strict';

// Deterministic stand-in for global.setTimeout/clearTimeout, so tests can drive timer-based
// loops (auto-IDLE, IDLE restart, fallback polling) without wall-clock sleeps.
//
// It is the suite's existing "swap global.setTimeout for the duration of a test and restore it
// in finally" idiom, made reusable and able to handle recursively scheduled timers: firing a
// timer whose callback schedules the next one records the new timer instead of losing it.
//
// Only timers scheduled while installed are faked. Everything else (setImmediate, socket
// timeouts, nodeunit's own bookkeeping) is untouched, and clearTimeout still forwards real
// handles to the real implementation. Install for as short a window as possible and always
// restore in a finally block.
const installFakeTimers = () => {
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;

    let seq = 0;
    const timers = new Map();
    // Every timer ever scheduled, including cleared and fired ones, so tests can assert timer
    // identity and cleanup (which timer was armed, was it unref'd, was it cleared) without sleeps.
    const history = [];

    global.setTimeout = (fn, delay, ...args) => {
        const id = ++seq;
        const timer = { id, fn, delay, args, unrefd: false, cleared: false, fired: false };
        timers.set(id, timer);
        history.push(timer);
        return {
            _fakeTimerId: id,
            unref() {
                const timer = timers.get(id);
                if (timer) {
                    timer.unrefd = true;
                }
                return this;
            },
            ref() {
                return this;
            }
        };
    };

    global.clearTimeout = handle => {
        if (handle && handle._fakeTimerId) {
            const timer = timers.get(handle._fakeTimerId);
            if (timer) {
                timer.cleared = true;
                timers.delete(timer.id);
            }
            return;
        }
        return realClearTimeout(handle);
    };

    // Lets pending asynchronous work (a poll's promise chain) settle between timer firings.
    const drain = async (turns = 3) => {
        for (let i = 0; i < turns; i++) {
            await new Promise(resolve => setImmediate(resolve));
        }
    };

    return {
        // Scheduled timers that have not fired or been cleared yet, in scheduling order
        pending: () => Array.from(timers.values()).map(timer => ({ id: timer.id, delay: timer.delay, unrefd: timer.unrefd })),
        count: () => timers.size,

        // Every timer scheduled while installed, in scheduling order, with its final state
        history: () => history.map(timer => ({ id: timer.id, delay: timer.delay, unrefd: timer.unrefd, cleared: timer.cleared, fired: timer.fired })),

        // Fires every currently pending timer once, oldest first, letting async callbacks settle.
        // Timers scheduled by those callbacks stay pending for the next fire() call, which is what
        // makes a recursive loop (poll -> schedule -> poll) observable one step at a time.
        fire: async () => {
            const due = Array.from(timers.values());
            for (const timer of due) {
                if (!timers.has(timer.id)) {
                    // cleared by an earlier callback in this batch
                    continue;
                }
                timers.delete(timer.id);
                timer.fired = true;
                timer.fn(...timer.args);
                await drain();
            }
        },

        drain,

        restore: () => {
            global.setTimeout = realSetTimeout;
            global.clearTimeout = realClearTimeout;
            timers.clear();
        }
    };
};

/**
 * Runs `fn` with faked timers installed, restoring the real ones afterwards. Always use this
 * rather than installing by hand: leaking faked globals into the rest of the run breaks
 * unrelated tests.
 *
 * @param {Function} fn - Receives the timer controller.
 * @returns {Promise<*>} Whatever `fn` returns.
 */
const withFakeTimers = async fn => {
    const timers = installFakeTimers();
    try {
        return await fn(timers);
    } finally {
        timers.restore();
    }
};

module.exports = { installFakeTimers, withFakeTimers };
