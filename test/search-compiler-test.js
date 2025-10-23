'use strict';

const { searchCompiler } = require('../lib/search-compiler');

// Mock connection for testing
let createMockConnection = () => ({
    capabilities: new Map([
        ['IMAP4rev1', true],
        ['UTF8=ACCEPT', true]
    ]),
    enabled: new Set(['UTF8=ACCEPT'])
});

// Mock mailbox for testing
let createMockMailbox = () => ({
    flags: new Set(['\\Seen', '\\Answered', '\\Flagged', '\\Deleted', '\\Draft']),
    permanentFlags: new Set(['\\*'])
});

module.exports['Search Compiler: Basic functionality'] = test => {
    let connection = createMockConnection();
    let mailbox = createMockMailbox();

    test.doesNotThrow(() => {
        let compiled = searchCompiler(connection, { seen: false }, mailbox);
        test.ok(Array.isArray(compiled));
    });

    test.done();
};

module.exports['Search Compiler: Text searches'] = test => {
    let connection = createMockConnection();
    let mailbox = createMockMailbox();

    let compiled = searchCompiler(
        connection,
        {
            from: 'user@example.com',
            subject: 'Test'
        },
        mailbox
    );

    test.ok(Array.isArray(compiled));
    test.ok(compiled.length > 0);
    test.done();
};

module.exports['Search Compiler: Flag searches'] = test => {
    let connection = createMockConnection();
    let mailbox = createMockMailbox();

    let compiled = searchCompiler(
        connection,
        {
            seen: true,
            answered: false
        },
        mailbox
    );

    test.ok(Array.isArray(compiled));
    test.ok(compiled.length > 0);
    test.done();
};

module.exports['Search Compiler: Date searches'] = test => {
    let connection = createMockConnection();
    let mailbox = createMockMailbox();

    let compiled = searchCompiler(
        connection,
        {
            since: new Date('2023-01-01')
        },
        mailbox
    );

    test.ok(Array.isArray(compiled));
    test.ok(compiled.length > 0);
    test.done();
};

module.exports['Search Compiler: Empty query'] = test => {
    let connection = createMockConnection();
    let mailbox = createMockMailbox();

    let compiled = searchCompiler(connection, {}, mailbox);

    test.ok(Array.isArray(compiled));
    test.done();
};
