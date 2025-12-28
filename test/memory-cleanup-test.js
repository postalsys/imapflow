'use strict';

/**
 * Tests for memory cleanup on connection close
 */

const { ImapFlow } = require('../lib/imap-flow');

exports['Memory Cleanup Tests'] = {
    'should clean up streamer on close without connection'(test) {
        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            logger: false
        });

        // Check initial state
        test.ok(client.streamer, 'streamer should exist');
        test.ok(!client.streamer.destroyed, 'streamer should not be destroyed initially');

        // Close without connecting
        client.close();

        // Verify cleanup
        test.ok(client.streamer.destroyed, 'streamer should be destroyed after close');
        test.equal(client.streamer.listenerCount('error'), 0, 'error listeners should be removed');
        test.equal(client.folders.size, 0, 'folders should be cleared');
        test.equal(client.requestTagMap.size, 0, 'requestTagMap should be cleared');
        test.ok(client.isClosed, 'client should be marked as closed');

        test.done();
    },

    'should remove event listeners on close'(test) {
        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            logger: false
        });

        // Add a readable listener as if connect was called
        client.socketReadable = () => {};
        client.streamer.on('readable', client.socketReadable);

        // Verify listener was added
        test.equal(client.streamer.listenerCount('readable'), 1, 'readable listener should be present');

        client.close();

        // Check listeners after close
        test.equal(client.streamer.listenerCount('readable'), 0, 'readable listener should be removed');
        test.equal(client.streamer.listenerCount('error'), 0, 'error listeners should be removed');

        test.done();
    },

    'should clear internal structures on close'(test) {
        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            logger: false
        });

        // Add some data to internal structures
        client.folders.set('INBOX', { path: 'INBOX' });
        client.folders.set('Sent', { path: 'Sent' });
        client.requestTagMap.set('A001', { tag: 'A001' });
        client.requestTagMap.set('A002', { tag: 'A002' });

        test.equal(client.folders.size, 2, 'folders should have entries');
        test.equal(client.requestTagMap.size, 2, 'requestTagMap should have entries');

        client.close();

        test.equal(client.folders.size, 0, 'folders should be cleared after close');
        test.equal(client.requestTagMap.size, 0, 'requestTagMap should be cleared after close');

        test.done();
    },

    'should handle multiple close calls gracefully'(test) {
        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            logger: false
        });

        // Call close multiple times
        test.doesNotThrow(() => {
            client.close();
            client.close();
            client.close();
        }, 'multiple close calls should not throw');

        test.ok(client.isClosed, 'client should be marked as closed');

        test.done();
    },

    'should properly set state on close'(test) {
        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            logger: false
        });

        test.equal(client.state, client.states.NOT_AUTHENTICATED, 'initial state should be NOT_AUTHENTICATED');
        test.equal(client.usable, false, 'usable should be false initially');
        test.equal(client.isClosed, false, 'isClosed should be false initially');

        client.close();

        test.equal(client.state, client.states.LOGOUT, 'state should be LOGOUT after close');
        test.equal(client.usable, false, 'usable should be false after close');
        test.equal(client.isClosed, true, 'isClosed should be true after close');

        test.done();
    },

    'should emit close event'(test) {
        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            logger: false
        });

        let closeEmitted = false;
        client.on('close', () => {
            closeEmitted = true;
        });

        client.close();

        test.ok(closeEmitted, 'close event should be emitted');

        test.done();
    }
};
