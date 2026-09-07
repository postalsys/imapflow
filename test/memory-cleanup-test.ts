import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapFlow } from '../src/imap-flow.js';

describe('memory-cleanup', () => {
    /**
     * Tests for memory cleanup on connection close
     */
    describe('Memory Cleanup Tests', () => {
        it('should clean up streamer on close without connection', () => {
            const client = new ImapFlow({
                host: '127.0.0.1',
                port: 1,
                secure: false,
                logger: false
            });

            // Check initial state
            assert.ok(client.streamer, 'streamer should exist');
            assert.ok(!client.streamer.destroyed, 'streamer should not be destroyed initially');

            // Close without connecting
            client.close();

            // Verify cleanup
            assert.ok(client.streamer.destroyed, 'streamer should be destroyed after close');
            assert.equal(client.streamer.listenerCount('error'), 0, 'error listeners should be removed');
            assert.equal(client.folders.size, 0, 'folders should be cleared');
            assert.equal(client.requestTagMap.size, 0, 'requestTagMap should be cleared');
            assert.ok(client.isClosed, 'client should be marked as closed');
        });

        it('should remove event listeners on close', () => {
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
            assert.equal(client.streamer.listenerCount('readable'), 1, 'readable listener should be present');

            client.close();

            // Check listeners after close
            assert.equal(client.streamer.listenerCount('readable'), 0, 'readable listener should be removed');
            assert.equal(client.streamer.listenerCount('error'), 0, 'error listeners should be removed');
        });

        it('should clear internal structures on close', () => {
            const client = new ImapFlow({
                host: '127.0.0.1',
                port: 1,
                secure: false,
                logger: false
            });

            // Add some data to internal structures
            client.folders.set('INBOX', { path: 'INBOX' } as any);
            client.folders.set('Sent', { path: 'Sent' } as any);
            client.requestTagMap.set('A001', { tag: 'A001' } as any);
            client.requestTagMap.set('A002', { tag: 'A002' } as any);

            assert.equal(client.folders.size, 2, 'folders should have entries');
            assert.equal(client.requestTagMap.size, 2, 'requestTagMap should have entries');

            client.close();

            assert.equal(client.folders.size, 0, 'folders should be cleared after close');
            assert.equal(client.requestTagMap.size, 0, 'requestTagMap should be cleared after close');
        });

        it('should handle multiple close calls gracefully', () => {
            const client = new ImapFlow({
                host: '127.0.0.1',
                port: 1,
                secure: false,
                logger: false
            });

            // Call close multiple times
            assert.doesNotThrow(() => {
                client.close();
                client.close();
                client.close();
            }, 'multiple close calls should not throw');

            assert.ok(client.isClosed, 'client should be marked as closed');
        });

        it('should properly set state on close', () => {
            const client = new ImapFlow({
                host: '127.0.0.1',
                port: 1,
                secure: false,
                logger: false
            });

            assert.equal(client.state, client.states.NOT_AUTHENTICATED, 'initial state should be NOT_AUTHENTICATED');
            assert.equal(client.usable, false, 'usable should be false initially');
            assert.equal(client.isClosed, false, 'isClosed should be false initially');

            client.close();

            assert.equal(client.state, client.states.LOGOUT, 'state should be LOGOUT after close');
            assert.equal(client.usable, false, 'usable should be false after close');
            assert.equal(client.isClosed, true, 'isClosed should be true after close');
        });

        it('should emit close event', () => {
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

            assert.ok(closeEmitted, 'close event should be emitted');
        });
    });
});
