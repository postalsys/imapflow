import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCopyUid } from '../src/commands/copyuid-parser.js';

/**
 * Builds a minimal IMAP response object with a COPYUID-style section.
 *
 * @param {Array} section - Array of section elements with value properties
 * @returns {Object} Response object suitable for parseCopyUid
 */
function makeResponse(section: any) {
    return { attributes: [{ section }] };
}

describe('copyuid-parser', () => {
    // ============================================
    // Single UID pair
    // ============================================
    it('CopyUID Parser: single UID pair sets uidValidity and uidMap entry', () => {
        let map: any = {};
        parseCopyUid(makeResponse([{ value: 'COPYUID' }, { value: '12345' }, { value: '1' }, { value: '100' }]) as any, map);

        assert.equal(map.uidValidity, BigInt('12345'));
        assert.ok((map as any).uidMap instanceof Map);
        assert.equal((map as any).uidMap.get(1), 100);
        assert.equal((map as any).uidMap.size, 1);
    });

    // ============================================
    // UID ranges
    // ============================================
    it('CopyUID Parser: contiguous UID range maps all source UIDs to destinations', () => {
        let map: any = {};
        parseCopyUid(makeResponse([{ value: 'COPYUID' }, { value: '99' }, { value: '1:3' }, { value: '10:12' }]) as any, map);

        assert.equal(map.uidValidity, BigInt('99'));
        assert.ok((map as any).uidMap instanceof Map);
        assert.equal((map as any).uidMap.size, 3);
        assert.equal((map as any).uidMap.get(1), 10);
        assert.equal((map as any).uidMap.get(2), 11);
        assert.equal((map as any).uidMap.get(3), 12);
    });

    // ============================================
    // Comma-separated UIDs
    // ============================================
    it('CopyUID Parser: comma-separated UIDs map each source to its destination', () => {
        let map: any = {};
        parseCopyUid(makeResponse([{ value: 'COPYUID' }, { value: '200' }, { value: '1,5,9' }, { value: '100,105,109' }]) as any, map);

        assert.equal(map.uidMap.size, 3);
        assert.equal((map as any).uidMap.get(1), 100);
        assert.equal((map as any).uidMap.get(5), 105);
        assert.equal((map as any).uidMap.get(9), 109);
    });

    // ============================================
    // Non-COPYUID response code
    // ============================================
    it('CopyUID Parser: non-COPYUID response code leaves map unchanged', () => {
        let map: any = {};
        parseCopyUid(makeResponse([{ value: 'APPENDUID' }, { value: '12345' }, { value: '1' }, { value: '100' }]) as any, map);

        assert.equal(map.uidValidity, undefined);
        assert.equal((map as any).uidMap, undefined);
    });

    // ============================================
    // Missing / malformed input
    // ============================================
    it('CopyUID Parser: missing attributes leaves map unchanged', () => {
        let map: any = {};
        parseCopyUid({}, map);

        assert.equal((map as any).uidValidity, undefined);
        assert.equal((map as any).uidMap, undefined);
    });
    it('CopyUID Parser: empty attributes array leaves map unchanged', () => {
        let map: any = {};
        parseCopyUid({ attributes: [] }, map);

        assert.equal((map as any).uidValidity, undefined);
        assert.equal((map as any).uidMap, undefined);
    });
    it('CopyUID Parser: null section leaves map unchanged', () => {
        let map: any = {};
        parseCopyUid({ attributes: [{ section: null }] } as any, map);

        assert.equal(map.uidValidity, undefined);
        assert.equal((map as any).uidMap, undefined);
    });

    // ============================================
    // Non-numeric uidValidity
    // ============================================
    it('CopyUID Parser: non-numeric uidValidity skips uidValidity but still builds uidMap', () => {
        let map: any = {};
        parseCopyUid(makeResponse([{ value: 'COPYUID' }, { value: 'abc' }, { value: '1' }, { value: '100' }]) as any, map);

        assert.equal(map.uidValidity, undefined);
        assert.ok((map as any).uidMap instanceof Map);
        assert.equal((map as any).uidMap.get(1), 100);
    });

    // ============================================
    // Mismatched source/destination lengths
    // ============================================
    it('CopyUID Parser: mismatched source and destination lengths sets uidValidity but skips uidMap', () => {
        let map: any = {};
        parseCopyUid(makeResponse([{ value: 'COPYUID' }, { value: '12345' }, { value: '1:3' }, { value: '10' }]) as any, map);

        assert.equal(map.uidValidity, BigInt('12345'));
        assert.equal((map as any).uidMap, undefined);
    });

    // ============================================
    // Large uidValidity
    // ============================================
    it('CopyUID Parser: large uidValidity is stored as BigInt', () => {
        let map: any = {};
        parseCopyUid(makeResponse([{ value: 'COPYUID' }, { value: '999999999999' }, { value: '1' }, { value: '100' }]) as any, map);

        assert.equal(map.uidValidity, BigInt('999999999999'));
    });
    it('CopyUID Parser: uidValidity zero is stored as BigInt(0)', () => {
        let map: any = {};
        parseCopyUid(makeResponse([{ value: 'COPYUID' }, { value: '0' }, { value: '1' }, { value: '100' }]) as any, map);

        assert.strictEqual(map.uidValidity, BigInt(0));
        assert.ok((map as any).uidMap instanceof Map);
        assert.equal((map as any).uidMap.get(1), 100);
    });

    // ============================================
    // Hostile server input
    // ============================================
    it('CopyUID Parser: non-decimal uidValidity is ignored, uidMap still parsed', () => {
        // isNaN() passed values like "1e5" and "Infinity" through, and BigInt() then threw,
        // losing the whole COPYUID result
        let map: any = {};
        parseCopyUid(makeResponse([{ value: 'COPYUID' }, { value: '1e5' }, { value: '1' }, { value: '100' }]) as any, map);
        assert.equal(map.uidValidity, undefined);
        assert.ok((map as any).uidMap instanceof Map);
        assert.equal((map as any).uidMap.get(1), 100);

        let map2: any = {};
        parseCopyUid(makeResponse([{ value: 'COPYUID' }, { value: 'Infinity' }, { value: '1' }, { value: '100' }]) as any, map2);
        assert.equal(map2.uidValidity, undefined);
        assert.equal((map2 as any).uidMap.get(1), 100);
    });
});
