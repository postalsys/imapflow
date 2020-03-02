/* eslint global-require:0 */

'use strict';

module.exports = new Map([
    ['ID', require('./commands/id.js')],
    ['CAPABILITY', require('./commands/capability.js')],
    ['NAMESPACE', require('./commands/namespace.js')],
    ['LOGIN', require('./commands/login.js')],
    ['LOGOUT', require('./commands/logout.js')],
    ['STARTTLS', require('./commands/starttls.js')],
    ['LIST', require('./commands/list.js')],
    ['ENABLE', require('./commands/enable.js')],
    ['SELECT', require('./commands/select.js')],
    ['FETCH', require('./commands/fetch.js')],
    ['CREATE', require('./commands/create.js')],
    ['DELETE', require('./commands/delete.js')],
    ['RENAME', require('./commands/rename.js')],
    ['CLOSE', require('./commands/close.js')],
    ['SUBSCRIBE', require('./commands/subscribe.js')],
    ['UNSUBSCRIBE', require('./commands/unsubscribe.js')],
    ['STORE', require('./commands/store.js')],
    ['SEARCH', require('./commands/search.js')],
    ['NOOP', require('./commands/noop.js')],
    ['EXPUNGE', require('./commands/expunge.js')],
    ['APPEND', require('./commands/append.js')],
    ['STATUS', require('./commands/status.js')],
    ['COPY', require('./commands/copy.js')],
    ['MOVE', require('./commands/move.js')],
    ['COMPRESS', require('./commands/compress.js')],
    ['QUOTA', require('./commands/quota.js')],
    ['IDLE', require('./commands/idle.js')],
    ['AUTHENTICATE', require('./commands/authenticate.js')]
]);
