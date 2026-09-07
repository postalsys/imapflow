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
        return 'latest';
    }
};
