'use strict';

const specialUse = require('../lib/special-use');

module.exports['Special Use: flags array'] = test => {
    test.ok(Array.isArray(specialUse.flags));
    test.ok(specialUse.flags.includes('\\Sent'));
    test.ok(specialUse.flags.includes('\\Drafts'));
    test.ok(specialUse.flags.includes('\\Trash'));
    test.ok(specialUse.flags.includes('\\Archive'));
    test.done();
};

module.exports['Special Use: names object'] = test => {
    test.ok(typeof specialUse.names === 'object');
    test.ok(specialUse.names['\\Sent']);
    test.ok(Array.isArray(specialUse.names['\\Sent']));
    test.ok(specialUse.names['\\Sent'].includes('sent'));
    test.done();
};

module.exports['Special Use: Sent folder names'] = test => {
    let sentNames = specialUse.names['\\Sent'];
    test.ok(sentNames.includes('sent'));
    test.ok(sentNames.includes('sent items'));
    test.ok(sentNames.includes('sent messages'));
    test.done();
};

module.exports['Special Use: Drafts folder names'] = test => {
    let draftsNames = specialUse.names['\\Drafts'];
    test.ok(draftsNames.includes('drafts'));
    test.done();
};

module.exports['Special Use: Trash folder names'] = test => {
    let trashNames = specialUse.names['\\Trash'];
    test.ok(trashNames.includes('trash'));
    test.ok(trashNames.includes('deleted items'));
    test.ok(trashNames.includes('deleted messages'));
    test.done();
};

module.exports['Special Use: Junk folder names'] = test => {
    let junkNames = specialUse.names['\\Junk'];
    test.ok(junkNames.includes('spam'));
    test.ok(junkNames.includes('junk'));
    test.done();
};
