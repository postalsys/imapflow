// Globals ImapFlow and its dependencies use that browsers do not have, injected by esbuild into
// the bundle (test/browser/browser-test.ts) rather than set on window

import { Buffer } from 'buffer';
import process from 'process/browser.js';

export { Buffer, process };

// setImmediate runs on the next event loop turn. A MessageChannel message is the closest a
// browser has, a zero timer is clamped to 4 ms once timers nest
const queue = new Map();
let nextId = 1;
const channel = new MessageChannel();
channel.port1.onmessage = event => {
    const task = queue.get(event.data);
    if (task) {
        queue.delete(event.data);
        task.fn(...task.args);
    }
};

export function setImmediate(fn, ...args) {
    const id = nextId++;
    queue.set(id, { fn, args });
    channel.port2.postMessage(id);
    return id;
}

export function clearImmediate(id) {
    queue.delete(id);
}
