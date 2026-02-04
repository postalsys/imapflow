'use strict';

const sortCommand = require('../lib/commands/sort');

// Mock connection for testing
let createMockConnection = (options = {}) => ({
    state: 'SELECTED',
    states: { SELECTED: 'SELECTED' },
    capabilities: new Map(options.capabilities || [['SORT', true]]),
    exec: options.exec || (async () => ({ next: () => {} })),
    log: { warn: () => {} }
});

// ============================================
// SORT command tests
// ============================================

module.exports['SORT Command: Returns false if not in SELECTED state'] = async test => {
    let connection = createMockConnection();
    connection.state = 'AUTHENTICATED';

    let result = await sortCommand(connection, ['DATE'], { all: true }, {});
    test.strictEqual(result, false);
    test.done();
};

module.exports['SORT Command: Returns false if SORT capability not available'] = async test => {
    let connection = createMockConnection({
        capabilities: new Map([['IMAP4rev1', true]]) // No SORT capability
    });

    let result = await sortCommand(connection, ['DATE'], { all: true }, {});
    test.strictEqual(result, false);
    test.done();
};

module.exports['SORT Command: Executes with string sort criteria'] = async test => {
    let executedCommand = null;
    let connection = createMockConnection({
        exec: async (cmd, attrs, opts) => {
            executedCommand = { cmd, attrs, opts };
            return { next: () => {} };
        }
    });

    await sortCommand(connection, ['REVERSE', 'DATE'], { all: true }, { uid: true });

    test.ok(executedCommand);
    test.equal(executedCommand.cmd, 'UID SORT');
    test.done();
};

module.exports['SORT Command: Executes with object sort criteria'] = async test => {
    let executedCommand = null;
    let connection = createMockConnection({
        exec: async (cmd, attrs, opts) => {
            executedCommand = { cmd, attrs, opts };
            return { next: () => {} };
        }
    });

    await sortCommand(connection, [{ reverse: true }, 'date'], { seen: false }, {});

    test.ok(executedCommand);
    test.equal(executedCommand.cmd, 'SORT');
    // Check that REVERSE is in the sort criteria
    let sortCriteria = executedCommand.attrs[0];
    test.ok(sortCriteria.some(a => a.value === 'REVERSE'));
    test.ok(sortCriteria.some(a => a.value === 'DATE'));
    test.done();
};

module.exports['SORT Command: Uses UTF-8 charset'] = async test => {
    let executedCommand = null;
    let connection = createMockConnection({
        exec: async (cmd, attrs, opts) => {
            executedCommand = { cmd, attrs, opts };
            return { next: () => {} };
        }
    });

    await sortCommand(connection, ['DATE'], { all: true }, {});

    test.ok(executedCommand);
    // Second attribute should be UTF-8 charset
    test.equal(executedCommand.attrs[1].value, 'UTF-8');
    test.done();
};

module.exports['SORT Command: Defaults to DATE if no sort criteria'] = async test => {
    let executedCommand = null;
    let connection = createMockConnection({
        exec: async (cmd, attrs, opts) => {
            executedCommand = { cmd, attrs, opts };
            return { next: () => {} };
        }
    });

    await sortCommand(connection, [], { all: true }, {});

    test.ok(executedCommand);
    let sortCriteria = executedCommand.attrs[0];
    test.ok(sortCriteria.some(a => a.value === 'DATE'));
    test.done();
};
