// Deterministic stand-in for global setTimeout/clearTimeout, so tests can drive timer-based
// loops (auto-IDLE, IDLE restart, fallback polling) without wall-clock sleeps.
//
// It is the suite's existing "swap global setTimeout for the duration of a test and restore it
// in finally" idiom, made reusable and able to handle recursively scheduled timers: firing a
// timer whose callback schedules the next one records the new timer instead of losing it.
//
// Only timers scheduled while installed are faked. Everything else (setImmediate, socket
// timeouts, the test runner's own bookkeeping) is untouched, and clearTimeout still forwards real
// handles to the real implementation. Install for as short a window as possible and always
// restore in a finally block.

export interface FakeTimer {
    id: number;
    fn: (...args: any[]) => void;
    delay: number | undefined;
    args: any[];
    unrefd: boolean;
    cleared: boolean;
    fired: boolean;
}

export interface FakeTimerState {
    id: number;
    delay: number | undefined;
    unrefd: boolean;
    cleared?: boolean;
    fired?: boolean;
}

export interface FakeTimers {
    pending: () => FakeTimerState[];
    count: () => number;
    history: () => FakeTimerState[];
    find: (handle: unknown) => FakeTimerState | undefined;
    fire: () => Promise<void>;
    drain: (turns?: number) => Promise<void>;
    restore: () => void;
}

const installFakeTimers = (): FakeTimers => {
    const globalAny = globalThis as any;
    const realSetTimeout = globalAny.setTimeout;
    const realClearTimeout = globalAny.clearTimeout;

    let seq = 0;
    const timers = new Map<number, FakeTimer>();
    // Every timer ever scheduled, including cleared and fired ones, so tests can assert timer
    // identity and cleanup (which timer was armed, was it unref'd, was it cleared) without sleeps.
    const history: FakeTimer[] = [];

    globalAny.setTimeout = (fn: (...args: any[]) => void, delay: number | undefined, ...args: any[]) => {
        const id = ++seq;
        const timer: FakeTimer = { id, fn, delay, args, unrefd: false, cleared: false, fired: false };
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
            },
            // Bun's net sockets keep their inactivity timer through the global setTimeout and
            // call refresh() on the handle, Node's use an internal timer list
            refresh() {
                return this;
            },
            hasRef() {
                const timer = timers.get(id);
                return !!timer && !timer.unrefd;
            }
        };
    };

    globalAny.clearTimeout = (handle: any) => {
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

    const snapshot = (timer: FakeTimer): FakeTimerState => ({
        id: timer.id,
        delay: timer.delay,
        unrefd: timer.unrefd,
        cleared: timer.cleared,
        fired: timer.fired
    });

    return {
        // Scheduled timers that have not fired or been cleared yet, in scheduling order
        pending: () => Array.from(timers.values()).map(timer => ({ id: timer.id, delay: timer.delay, unrefd: timer.unrefd })),
        count: () => timers.size,

        // Every timer scheduled while installed, in scheduling order, with its final state
        history: () => history.map(snapshot),

        // The recorded state of the timer behind a handle the code under test kept, so a test can
        // assert on a timer by identity rather than by its delay or its position in the history
        find: (handle: unknown) => {
            const id = (handle as { _fakeTimerId?: number } | null | undefined)?._fakeTimerId;
            const timer = history.find(timer => timer.id === id);
            return timer && snapshot(timer);
        },

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
            globalAny.setTimeout = realSetTimeout;
            globalAny.clearTimeout = realClearTimeout;
            timers.clear();
        }
    };
};

/**
 * Runs `fn` with faked timers installed, restoring the real ones afterwards. Always use this
 * rather than installing by hand: leaking faked globals into the rest of the run breaks
 * unrelated tests.
 *
 * @param fn - Receives the timer controller.
 * @returns Whatever `fn` returns.
 */
const withFakeTimers = async <T>(fn: (timers: FakeTimers) => Promise<T> | T): Promise<T> => {
    const timers = installFakeTimers();
    try {
        return await fn(timers);
    } finally {
        timers.restore();
    }
};

export { withFakeTimers };
