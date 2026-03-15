'use strict';

const { parseCopyUid } = require('../lib/commands/copyuid-parser');

/**
 * Builds a minimal IMAP response object with a COPYUID-style section.
 *
 * @param {Array} section - Array of section elements with value properties
 * @returns {Object} Response object suitable for parseCopyUid
 */
function makeResponse(section) {
    return { attributes: [{ section }] };
}

// ============================================
// Single UID pair
// ============================================

module.exports['CopyUID Parser: single UID pair sets uidValidity and uidMap entry'] = test => {
    let map = {};
    parseCopyUid(makeResponse([{ value: 'COPYUID' }, { value: '12345' }, { value: '1' }, { value: '100' }]), map);

    test.equal(map.uidValidity, BigInt('12345'));
    test.ok(map.uidMap instanceof Map);
    test.equal(map.uidMap.get(1), 100);
    test.equal(map.uidMap.size, 1);
    test.done();
};

// ============================================
// UID ranges
// ============================================

module.exports['CopyUID Parser: contiguous UID range maps all source UIDs to destinations'] = test => {
    let map = {};
    parseCopyUid(makeResponse([{ value: 'COPYUID' }, { value: '99' }, { value: '1:3' }, { value: '10:12' }]), map);

    test.equal(map.uidValidity, BigInt('99'));
    test.ok(map.uidMap instanceof Map);
    test.equal(map.uidMap.size, 3);
    test.equal(map.uidMap.get(1), 10);
    test.equal(map.uidMap.get(2), 11);
    test.equal(map.uidMap.get(3), 12);
    test.done();
};

// ============================================
// Comma-separated UIDs
// ============================================

module.exports['CopyUID Parser: comma-separated UIDs map each source to its destination'] = test => {
    let map = {};
    parseCopyUid(makeResponse([{ value: 'COPYUID' }, { value: '200' }, { value: '1,5,9' }, { value: '100,105,109' }]), map);

    test.equal(map.uidMap.size, 3);
    test.equal(map.uidMap.get(1), 100);
    test.equal(map.uidMap.get(5), 105);
    test.equal(map.uidMap.get(9), 109);
    test.done();
};

// ============================================
// Non-COPYUID response code
// ============================================

module.exports['CopyUID Parser: non-COPYUID response code leaves map unchanged'] = test => {
    let map = {};
    parseCopyUid(makeResponse([{ value: 'APPENDUID' }, { value: '12345' }, { value: '1' }, { value: '100' }]), map);

    test.equal(map.uidValidity, undefined);
    test.equal(map.uidMap, undefined);
    test.done();
};

// ============================================
// Missing / malformed input
// ============================================

module.exports['CopyUID Parser: missing attributes leaves map unchanged'] = test => {
    let map = {};
    parseCopyUid({}, map);

    test.equal(map.uidValidity, undefined);
    test.equal(map.uidMap, undefined);
    test.done();
};

module.exports['CopyUID Parser: empty attributes array leaves map unchanged'] = test => {
    let map = {};
    parseCopyUid({ attributes: [] }, map);

    test.equal(map.uidValidity, undefined);
    test.equal(map.uidMap, undefined);
    test.done();
};

module.exports['CopyUID Parser: null section leaves map unchanged'] = test => {
    let map = {};
    parseCopyUid({ attributes: [{ section: null }] }, map);

    test.equal(map.uidValidity, undefined);
    test.equal(map.uidMap, undefined);
    test.done();
};

// ============================================
// Non-numeric uidValidity
// ============================================

module.exports['CopyUID Parser: non-numeric uidValidity skips uidValidity but still builds uidMap'] = test => {
    let map = {};
    parseCopyUid(makeResponse([{ value: 'COPYUID' }, { value: 'abc' }, { value: '1' }, { value: '100' }]), map);

    test.equal(map.uidValidity, undefined);
    test.ok(map.uidMap instanceof Map);
    test.equal(map.uidMap.get(1), 100);
    test.done();
};

// ============================================
// Mismatched source/destination lengths
// ============================================

module.exports['CopyUID Parser: mismatched source and destination lengths sets uidValidity but skips uidMap'] = test => {
    let map = {};
    parseCopyUid(makeResponse([{ value: 'COPYUID' }, { value: '12345' }, { value: '1:3' }, { value: '10' }]), map);

    test.equal(map.uidValidity, BigInt('12345'));
    test.equal(map.uidMap, undefined);
    test.done();
};

// ============================================
// Large uidValidity
// ============================================

module.exports['CopyUID Parser: large uidValidity is stored as BigInt'] = test => {
    let map = {};
    parseCopyUid(makeResponse([{ value: 'COPYUID' }, { value: '999999999999' }, { value: '1' }, { value: '100' }]), map);

    test.equal(map.uidValidity, BigInt('999999999999'));
    test.done();
};

module.exports['CopyUID Parser: uidValidity zero is stored as BigInt(0)'] = test => {
    let map = {};
    parseCopyUid(makeResponse([{ value: 'COPYUID' }, { value: '0' }, { value: '1' }, { value: '100' }]), map);

    test.strictEqual(map.uidValidity, BigInt(0));
    test.ok(map.uidMap instanceof Map);
    test.equal(map.uidMap.get(1), 100);
    test.done();
};
