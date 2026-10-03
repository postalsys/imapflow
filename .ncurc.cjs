'use strict';

module.exports = {
    upgrade: true,
    // types-node-legacy is an alias of an old @types/node release that the package test
    // type-checks the declarations against on purpose, it must not be bumped
    reject: ['types-node-legacy'],
    target: name => {
        // @types/node stays on the 20.x line so the compiler rejects APIs that do
        // not exist on Node 20, the oldest supported version
        if (name === '@types/node') {
            return 'minor';
        }
        // typescript-eslint declares a peer range that excludes TypeScript 7
        if (name === 'typescript') {
            return 'minor';
        }
        // Held on 10.3.x to match EmailEngine, which bundles ImapFlow into a pkg binary. pino 10.4.0
        // makes lib/caller.js prefer util.getCallSites(), and inside a pkg binary that call aborts
        // the whole process with a V8 CHECK failure (SIGTRAP) the moment a logger is constructed.
        // ImapFlow builds its own pino logger whenever the caller passes none, and a copy that
        // differs from EmailEngine's own pin is also a second pino in its tree. 'patch' because
        // the break arrived in a minor. Lift together with EmailEngine's cap, see its .ncurc.js
        if (name === 'pino') {
            return 'patch';
        }
        return 'latest';
    }
};
