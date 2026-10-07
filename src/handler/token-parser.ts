/* eslint new-cap: 0 */

import imapFormalSyntax from './imap-formal-syntax.js';
import { MAX_LITERAL_SIZE, normalizeLimit, createLiteralTooLargeError } from './limits.js';
import type { ImapFlowError } from '../errors.js';
import type { ImapAttributeList, ImapAttributeNode, ParserOptions } from './types.js';
import type { ParserInstance } from './parser-instance.js';

const STATE_ATOM = 0x001;
const STATE_LITERAL = 0x002;
const STATE_NORMAL = 0x003;
const STATE_PARTIAL = 0x004;
const STATE_SEQUENCE = 0x005;
const STATE_STRING = 0x006;

const RE_SINGLE_DIGIT = /^\d$/;

// Prevents stack overflow from maliciously crafted deeply-nested IMAP input (e.g., (((((...))))))
const MAX_NODE_DEPTH = 25;

/**
 * A node of the parse tree built by TokenParser. `type` is false for a node that has not
 * been classified yet, 'TREE' for the root, and otherwise the token or structure type
 * (ATOM, string, LITERAL, SEQUENCE, LIST, SECTION, PARTIAL).
 */
export interface TokenNode {
    childNodes: TokenNode[];
    type: string | false;
    value: string | Buffer;
    isClosed: boolean;
    parentNode?: TokenNode | undefined;
    depth: number;
    startPos?: number | undefined;
    endPos?: number | undefined;
    literalType?: string | undefined;
    /** Digits accumulated as a string while the literal marker is read, converted to a number once the marker closes */
    literalLength?: string | number | undefined;
    literalPlus?: boolean | undefined;
    started?: boolean | undefined;
    chBuffer?: Buffer | undefined;
    chPos?: number | undefined;
}

/**
 * The parent object a TokenParser reads the parsed command from
 */
export interface TokenParserParent {
    command?: string | undefined;
}

/**
 * Tokenizes an IMAP attribute string into a tree of typed nodes.
 * Handles all IMAP data types: atoms, quoted strings, literals (including literal8),
 * sequences, lists (parenthesized groups), sections (bracketed groups), and partial ranges.
 * Enforces a maximum nesting depth of {@link MAX_NODE_DEPTH} to prevent stack overflow
 * from malicious input.
 */
export class TokenParser {
    str: string;
    options: ParserOptions;
    parent: TokenParserParent | ParserInstance;
    maxLiteralSize: number;
    tree: TokenNode;
    currentNode: TokenNode;
    pos: number;
    state: number;
    declare expectedLiteralType?: string | false | undefined;

    /**
     * Creates a new TokenParser.
     *
     * @param parent - The parent ParserInstance that owns this token parser. Used to access the parsed command for context-sensitive parsing.
     * @param startPos - The starting position offset in the original input, used for error reporting.
     * @param str - The attribute string to tokenize.
     * @param options - Parser options.
     * @param options.literalPlus - Whether the LITERAL+ extension is in use.
     * @param options.literals - Pre-parsed literal values from the input stream.
     * @param options.maxLiteralSize - Maximum size (in bytes) of a literal parsed inline
     *   from the input, i.e. when no pre-parsed literal buffers were supplied. Defaults to 1GB.
     */
    constructor(
        parent: TokenParserParent | ParserInstance,
        startPos?: number | undefined,
        str?: string | null | undefined,
        options?: ParserOptions | undefined
    ) {
        this.str = (str || '').toString();
        this.options = options || {};
        this.parent = parent;

        // Same normalization and default as the streaming parser, so a direct user of this parser
        // gets the same bound (an explicit 0 means "reject any non-empty inline literal").
        this.maxLiteralSize = normalizeLimit(this.options.maxLiteralSize, MAX_LITERAL_SIZE);

        this.tree = this.currentNode = this.createNode();
        this.pos = startPos || 0;

        this.currentNode.type = 'TREE';

        this.state = STATE_NORMAL;
    }

    /**
     * Processes the input string and returns the parsed attributes as a flat array of typed objects.
     * Each attribute is an object with a `type` (e.g., "ATOM", "STRING", "LITERAL", "SEQUENCE")
     * and a `value` property. Lists are represented as nested arrays. Sections and partials are
     * attached as properties on the preceding attribute object.
     *
     * @returns A promise that resolves to an array of parsed attribute objects and nested arrays.
     * @throws {Error} If the input contains syntax errors or unclosed nodes.
     */
    async getAttributes(): Promise<ImapAttributeList> {
        await this.processString();

        const attributes: ImapAttributeList = [];
        let branch: ImapAttributeList = attributes;

        let walk = async (node: TokenNode): Promise<void> => {
            let curBranch = branch;
            let elm: ImapAttributeNode | ImapAttributeList;
            let partial: number[];

            if (!node.isClosed && node.type === 'SEQUENCE' && node.value === '*') {
                node.isClosed = true;
                node.type = 'ATOM';
            }

            // If the node was never closed, throw it
            if (!node.isClosed) {
                let error: ImapFlowError = new Error(`Unexpected end of input at position ${this.pos + this.str.length - 1} [E9]`);
                error.code = 'ParserError9';
                error.parserContext = { input: this.str, pos: this.pos + this.str.length - 1 };
                throw error;
            }

            let type = (node.type || '').toString().toUpperCase();

            switch (type) {
                case 'LITERAL':
                case 'STRING':
                case 'SEQUENCE':
                    elm = {
                        type: (node.type as string).toUpperCase(),
                        value: node.value
                    };
                    branch.push(elm);
                    break;

                case 'ATOM':
                    if ((node.value as string).toUpperCase() === 'NIL') {
                        branch.push(null);
                        break;
                    }
                    elm = {
                        type: (node.type as string).toUpperCase(),
                        value: node.value
                    };
                    branch.push(elm);
                    break;

                case 'SECTION':
                    branch = (branch[branch.length - 1] as ImapAttributeNode).section = [];
                    break;

                case 'LIST':
                    elm = [];
                    branch.push(elm);
                    branch = elm;
                    break;

                case 'PARTIAL':
                    partial = (node.value as string).split('.').map(Number);
                    (branch[branch.length - 1] as ImapAttributeNode).partial = partial;
                    break;
            }

            for (let childNode of node.childNodes) {
                await walk(childNode);
            }

            branch = curBranch;
        };

        await walk(this.tree);

        return attributes;
    }

    /**
     * Creates a new node in the parse tree. Each node represents a token or structural
     * element (e.g., atom, string, literal, list, section, partial). The node is automatically
     * appended to the parent's childNodes array if a parent is provided.
     *
     * @param parentNode - The parent node to attach this node to. If omitted, creates a root node.
     * @param startPos - The starting position of this node in the original input string.
     * @returns The newly created node with childNodes, type, value, and isClosed properties.
     * @throws {Error} If the nesting depth exceeds MAX_NODE_DEPTH.
     */
    createNode(parentNode?: TokenNode | undefined, startPos?: number | undefined): TokenNode {
        let node: TokenNode = {
            childNodes: [],
            type: false,
            value: '',
            isClosed: true,
            depth: 0
        };

        if (parentNode) {
            node.parentNode = parentNode;
            node.depth = parentNode.depth + 1;
        } else {
            node.depth = 0;
        }

        if (node.depth > MAX_NODE_DEPTH) {
            let error: ImapFlowError = new Error('Too much nesting in IMAP string');
            error.code = 'MAX_IMAP_NESTING_REACHED';
            error._imapStr = this.str;
            throw error;
        }

        if (typeof startPos === 'number') {
            node.startPos = startPos;
        }

        if (parentNode) {
            parentNode.childNodes.push(node);
        }

        return node;
    }

    /**
     * Processes the entire input string character by character using a state machine.
     * Transitions between states (NORMAL, ATOM, STRING, LITERAL, SEQUENCE, PARTIAL, TEXT)
     * based on the current character and builds the parse tree. This is the main parsing
     * loop that drives the tokenization.
     *
     * @throws {Error} If the input contains unexpected characters, unclosed structures, or other syntax errors.
     */
    async processString(): Promise<void> {
        let chr: string, i: number, len: number;

        const checkSP = (): void => {
            // jump to the next non whitespace pos
            while (this.str.charAt(i + 1) === ' ') {
                i++;
            }
        };

        // Whether chr is the closing delimiter of node: ")" ends a LIST, "]" ends a SECTION
        const closesNode = (c: string, node: TokenNode | undefined): boolean =>
            !!node && ((c === ')' && node.type === 'LIST') || (c === ']' && node.type === 'SECTION'));

        // Facts about the ATOM, SEQUENCE or PARTIAL token being read, kept up to date as its
        // characters are appended. Reading them back from the value instead (value.at(-1),
        // value.includes('*'), a regex test) makes V8 flatten the string built with += on every
        // character, which is quadratic in the token length, and the server decides that length:
        // a 600 KB ESEARCH result took seconds of event loop time
        let tokenLength = 0;
        let tokenLast = '';
        let tokenPrev = '';
        let tokenDigitsOnly = true;
        let tokenHasStar = false;
        let tokenHasDot = false;

        const appendToToken = (c: string): void => {
            this.currentNode.value += c;
            tokenLength++;
            tokenPrev = tokenLast;
            tokenLast = c;
            tokenDigitsOnly = tokenDigitsOnly && RE_SINGLE_DIGIT.test(c);
            tokenHasStar = tokenHasStar || c === '*';
            tokenHasDot = tokenHasDot || c === '.';
        };

        // A digit-led token is only a guess at a sequence set. ":" and "," are ATOM-CHARs, so a
        // server sends a mailbox name, keyword or label such as "2024:Q1" or "1,a" unquoted, and
        // rejecting it would drop the whole response line: the mailbox missing from LIST, the
        // message missing from FETCH. When the sequence grammar breaks, such a token is read on as
        // an atom, and the atom rules decide whether the current character is acceptable. A token
        // holding "*" can not be an atom ("*" is not an ATOM-CHAR), so it keeps the sequence errors
        const continueAsAtom = (): void => {
            this.currentNode.type = 'ATOM';
            this.state = STATE_ATOM;
            // read the current character again, in STATE_ATOM
            i--;
        };

        // Starts the value of the current node as a new token, with its first character if any
        const startToken = (first?: string): void => {
            this.currentNode.value = '';
            tokenLength = 0;
            tokenLast = tokenPrev = '';
            tokenDigitsOnly = true;
            tokenHasStar = tokenHasDot = false;
            if (first) {
                appendToToken(first);
            }
        };

        // ImapStream supplies one buffer per literal marker it framed, {0} included. A marker
        // without a buffer means the line and its literals do not match up, so fail with a parser
        // error instead of reading a missing buffer or shifting every later literal by one
        const takeLiteral = (literals: Buffer[]): Buffer => {
            if (!literals.length) {
                let error: ImapFlowError = new Error(`Literal without data at position ${this.pos + i} [E35]`);
                error.code = 'ParserError35';
                error.parserContext = { input: this.str, pos: this.pos + i, chr };
                throw error;
            }
            return literals.shift()!;
        };

        // Any ATOM supported char starts a new Atom sequence, otherwise throw an error
        // Allow \ as the first char for atom to support system flags
        // Allow % to support LIST '' %
        // Allow 8bit characters (presumably unicode)
        // Shared by the default branch and by a '[' that is not a response code section, which
        // used to fall through into the default branch
        const startAtom = (): void => {
            if (!imapFormalSyntax['ATOM-CHAR']().includes(chr) && chr !== '\\' && chr !== '%' && chr.charCodeAt(0) < 0x80) {
                let error: ImapFlowError = new Error(`Unexpected char at position ${this.pos + i} [E13: ${JSON.stringify(chr)}]`);
                error.code = 'ParserError13';
                error.parserContext = { input: this.str, pos: this.pos + i, chr };
                throw error;
            }

            this.currentNode = this.createNode(this.currentNode, this.pos + i);
            this.currentNode.type = 'ATOM';
            startToken(chr);
            this.state = STATE_ATOM;
        };

        for (i = 0, len = this.str.length; i < len; i++) {
            chr = this.str.charAt(i);

            switch (this.state) {
                case STATE_NORMAL:
                    switch (chr) {
                        // DQUOTE starts a new string
                        case '"':
                            this.currentNode = this.createNode(this.currentNode, this.pos + i);
                            this.currentNode.type = 'string';
                            this.state = STATE_STRING;
                            this.currentNode.isClosed = false;
                            break;

                        // ( starts a new list
                        case '(':
                            this.currentNode = this.createNode(this.currentNode, this.pos + i);
                            this.currentNode.type = 'LIST';
                            this.currentNode.isClosed = false;
                            break;

                        // ) closes a list
                        case ')':
                            if (this.currentNode.type !== 'LIST') {
                                let error: ImapFlowError = new Error(`Unexpected list terminator ) at position ${this.pos + i} [E10]`);
                                error.code = 'ParserError10';
                                error.parserContext = { input: this.str, pos: this.pos + i, chr };
                                throw error;
                            }

                            this.currentNode.isClosed = true;
                            this.currentNode.endPos = this.pos + i;
                            this.currentNode = this.currentNode.parentNode!;

                            checkSP();
                            break;

                        // ] closes section group
                        case ']':
                            if (this.currentNode.type !== 'SECTION') {
                                let error: ImapFlowError = new Error(`Unexpected section terminator ] at position ${this.pos + i} [E11]`);
                                error.code = 'ParserError11';
                                error.parserContext = { input: this.str, pos: this.pos + i, chr };
                                throw error;
                            }
                            this.currentNode.isClosed = true;
                            this.currentNode.endPos = this.pos + i;
                            this.currentNode = this.currentNode.parentNode!;

                            checkSP();
                            break;

                        // < starts a new partial byte range (e.g., BODY[]<0.1024>)
                        case '<':
                            // '<' is only a partial range marker when it immediately follows ']',
                            // which occurs in BODY[section]<origin.length> responses.
                            // In all other contexts, '<' is treated as the start of an ATOM.
                            if (this.str.charAt(i - 1) !== ']') {
                                this.currentNode = this.createNode(this.currentNode, this.pos + i);
                                this.currentNode.type = 'ATOM';
                                startToken(chr);
                                this.state = STATE_ATOM;
                            } else {
                                this.currentNode = this.createNode(this.currentNode, this.pos + i);
                                this.currentNode.type = 'PARTIAL';
                                startToken();
                                this.state = STATE_PARTIAL;
                                this.currentNode.isClosed = false;
                            }
                            break;

                        // literal8 (RFC 3516): uses ~{size} prefix instead of {size}
                        // literal8 allows binary data containing NUL bytes, unlike regular literals
                        case '~': {
                            let nextChr = this.str.charAt(i + 1);
                            if (nextChr !== '{') {
                                // '~' is an ATOM-CHAR itself, so when it does not start a literal8
                                // it starts an atom, including the one-character atom "~" that a
                                // space, the end of the line or a closing delimiter ends
                                if (
                                    imapFormalSyntax['ATOM-CHAR']().includes(nextChr) ||
                                    nextChr === ' ' ||
                                    nextChr === '' ||
                                    closesNode(nextChr, this.currentNode)
                                ) {
                                    startAtom();
                                    break;
                                }

                                let error: ImapFlowError = new Error(`Unexpected literal8 marker at position ${this.pos + i} [E12]`);
                                error.code = 'ParserError12';
                                error.parserContext = { input: this.str, pos: this.pos + i, chr };
                                throw error;
                            }
                            // Mark the next literal as literal8 type; consumed when '{' is encountered
                            this.expectedLiteralType = 'literal8';
                            break;
                        }

                        // { starts a new literal (regular {size}\r\n or literal8 ~{size}\r\n)
                        case '{':
                            this.currentNode = this.createNode(this.currentNode, this.pos + i);
                            this.currentNode.type = 'LITERAL';
                            // Use literal8 type if '~' was seen immediately before, otherwise standard literal
                            this.currentNode.literalType = this.expectedLiteralType || 'literal';
                            this.expectedLiteralType = false;
                            this.state = STATE_LITERAL;
                            this.currentNode.isClosed = false;
                            break;

                        // * starts a new sequence
                        case '*':
                            this.currentNode = this.createNode(this.currentNode, this.pos + i);
                            this.currentNode.type = 'SEQUENCE';
                            startToken(chr);
                            this.currentNode.isClosed = false;
                            this.state = STATE_SEQUENCE;
                            break;

                        // normally a space should never occur
                        case ' ':
                            // just ignore
                            break;

                        // [ starts section
                        case '[':
                            // If it is the *first* element after response command, then process as a response argument list
                            // Status responses (OK/NO/BAD/BYE/PREAUTH) use [code] for response codes
                            if (
                                ['OK', 'NO', 'BAD', 'BYE', 'PREAUTH'].includes((this.parent.command as string).toUpperCase()) &&
                                this.currentNode === this.tree
                            ) {
                                this.currentNode.endPos = this.pos + i;

                                this.currentNode = this.createNode(this.currentNode, this.pos + i);
                                this.currentNode.type = 'ATOM';

                                this.currentNode = this.createNode(this.currentNode, this.pos + i);
                                this.currentNode.type = 'SECTION';
                                this.currentNode.isClosed = false;
                                this.state = STATE_NORMAL;

                                // RFC 2221 REFERRAL special case: the payload is an RFC 2192/RFC 5092
                                // IMAP URL (e.g., imap://user@host/mailbox) which contains characters
                                // that would break normal ATOM parsing (colons, slashes, etc.).
                                // We handle this by consuming everything up to ']' as a single ATOM value.
                                if (this.str.substring(i + 1, i + 10).toUpperCase() === 'REFERRAL ') {
                                    // create the REFERRAL atom
                                    this.currentNode = this.createNode(this.currentNode, this.pos + i + 1);
                                    this.currentNode.type = 'ATOM';
                                    this.currentNode.endPos = this.pos + i + 8;
                                    this.currentNode.value = 'REFERRAL';
                                    this.currentNode = this.currentNode.parentNode!;

                                    // eat all the way through the ] to be the  IMAPURL token.
                                    this.currentNode = this.createNode(this.currentNode, this.pos + i + 10);
                                    // just call this an ATOM, even though IMAPURL might be more correct
                                    this.currentNode.type = 'ATOM';
                                    // jump i to the ']' that closes the section. The URL itself can
                                    // hold a bracketed IPv6 host (imap://[::1]/INBOX), so brackets
                                    // opened inside the URL are matched before the closing one.
                                    let depth = 0;
                                    for (i = i + 10; i < this.str.length; i++) {
                                        let urlChr = this.str.charAt(i);
                                        if (urlChr === '[') {
                                            depth++;
                                        } else if (urlChr === ']' && depth-- === 0) {
                                            break;
                                        }
                                    }
                                    // A malformed REFERRAL with no closing ']' leaves i at the end of
                                    // the string, so the URL takes the rest of it.
                                    this.currentNode.endPos = this.pos + i - 1;
                                    this.currentNode.value = this.str.substring(this.currentNode.startPos! - this.pos, this.currentNode.endPos - this.pos + 1);
                                    this.currentNode = this.currentNode.parentNode!;

                                    // close out the SECTION
                                    this.currentNode.isClosed = true;
                                    this.currentNode = this.currentNode.parentNode!;

                                    checkSP();
                                }

                                break;
                            }

                            // Not a response code section: handled like any other atom start
                            startAtom();
                            break;

                        default:
                            startAtom();
                            break;
                    }
                    break;

                case STATE_ATOM:
                    // An atom is terminated by: space, closing delimiter of parent node,
                    // a backslash starting the next flag of a list (broken servers only),
                    // or encountering a '[' that starts a section for BODY/BINARY commands.
                    // space finishes an atom
                    if (chr === ' ') {
                        this.currentNode.endPos = this.pos + i - 1;
                        this.currentNode = this.currentNode.parentNode!;
                        this.state = STATE_NORMAL;
                        break;
                    }

                    // ')' or ']' terminates the atom AND closes the enclosing LIST or SECTION
                    if (closesNode(chr, this.currentNode.parentNode)) {
                        this.currentNode.endPos = this.pos + i - 1;
                        this.currentNode = this.currentNode.parentNode!;

                        this.currentNode.isClosed = true;
                        this.currentNode.endPos = this.pos + i;
                        this.currentNode = this.currentNode.parentNode!;
                        this.state = STATE_NORMAL;
                        checkSP();

                        break;
                    }

                    // A backslash can not occur inside an atom (it is a quoted-special), so one
                    // arriving inside a flag of a parenthesized list can only be a server that
                    // wrote two flags without the separating space, as home.pl does in its LIST
                    // responses ("\\Sent\\HasNoChildren"). Read it as the end of this flag and the
                    // start of the next one rather than rejecting the line, which would drop the
                    // whole mailbox. Only an atom that already is a flag is split, so an unquoted
                    // name is never cut in two, and only when a flag name follows, so a trailing
                    // backslash still fails as before instead of becoming a one-character flag
                    if (chr === '\\') {
                        const parent = this.currentNode.parentNode;
                        const value = this.currentNode.value as string;
                        const next = this.str.charAt(i + 1);
                        if (
                            parent &&
                            parent.type === 'LIST' &&
                            value.length > 1 &&
                            value.startsWith('\\') &&
                            next &&
                            (imapFormalSyntax['ATOM-CHAR']().includes(next) || next === '*')
                        ) {
                            this.currentNode.endPos = this.pos + i - 1;
                            this.currentNode = parent;
                            startAtom();
                            break;
                        }
                    }

                    // If the atom so far is all digits and we see ',' or ':', it is actually
                    // a sequence set (e.g., "1:5" or "1,3,5"), so reclassify and switch state
                    if ((chr === ',' || chr === ':') && tokenLength && tokenDigitsOnly) {
                        this.currentNode.type = 'SEQUENCE';
                        this.currentNode.isClosed = true;
                        this.state = STATE_SEQUENCE;
                    }

                    // [ starts a section group for this element
                    // Allowed only for selected elements, otherwise falls through to regular ATOM processing
                    if (
                        chr === '[' &&
                        tokenLength <= 11 &&
                        ['BODY', 'BODY.PEEK', 'BINARY', 'BINARY.PEEK'].includes((this.currentNode.value as string).toUpperCase())
                    ) {
                        this.currentNode.endPos = this.pos + i;
                        this.currentNode = this.createNode(this.currentNode.parentNode, this.pos + i);
                        this.currentNode.type = 'SECTION';
                        this.currentNode.isClosed = false;
                        this.state = STATE_NORMAL;
                        break;
                    }

                    // if the char is not ATOM compatible, throw. Allow \* as an exception
                    if (
                        !imapFormalSyntax['ATOM-CHAR']().includes(chr) &&
                        chr.charCodeAt(0) < 0x80 && // allow 8bit (presumably unicode) bytes
                        chr !== ']' &&
                        !(chr === '*' && this.currentNode.value === '\\') &&
                        (!this.parent || !this.parent.command || !['NO', 'BAD', 'OK'].includes(this.parent.command.toUpperCase()))
                    ) {
                        let error: ImapFlowError = new Error(`Unexpected char at position ${this.pos + i} [E16: ${JSON.stringify(chr)}]`);
                        error.code = 'ParserError16';
                        error.parserContext = { input: this.str, pos: this.pos + i, chr };
                        throw error;
                    } else if (this.currentNode.value === '\\*') {
                        let error: ImapFlowError = new Error(`Unexpected char at position ${this.pos + i} [E17: ${JSON.stringify(chr)}]`);
                        error.code = 'ParserError17';
                        error.parserContext = { input: this.str, pos: this.pos + i, chr };
                        throw error;
                    }

                    appendToToken(chr);
                    break;

                case STATE_STRING:
                    // DQUOTE ends the string sequence
                    if (chr === '"') {
                        this.currentNode.endPos = this.pos + i;
                        this.currentNode.isClosed = true;
                        this.currentNode = this.currentNode.parentNode!;
                        this.state = STATE_NORMAL;

                        checkSP();
                        break;
                    }

                    // \ Escapes the following char
                    if (chr === '\\') {
                        i++;
                        if (i >= len) {
                            let error: ImapFlowError = new Error(`Unexpected end of input at position ${this.pos + i} [E18]`);
                            error.code = 'ParserError18';
                            error.parserContext = { input: this.str, pos: this.pos + i };
                            throw error;
                        }
                        chr = this.str.charAt(i);
                    }

                    this.currentNode.value += chr;
                    break;

                case STATE_PARTIAL:
                    if (chr === '>') {
                        if (tokenLast === '.') {
                            let error: ImapFlowError = new Error(`Unexpected end of partial at position ${this.pos + i} [E19]`);
                            error.code = 'ParserError19';
                            error.parserContext = { input: this.str, pos: this.pos + i, chr };
                            throw error;
                        }
                        this.currentNode.endPos = this.pos + i;
                        this.currentNode.isClosed = true;
                        this.currentNode = this.currentNode.parentNode!;
                        this.state = STATE_NORMAL;
                        checkSP();
                        break;
                    }

                    if (chr === '.' && (!tokenLength || tokenHasDot)) {
                        let error: ImapFlowError = new Error(`Unexpected partial separator . at position ${this.pos + i} [E20]`);
                        error.code = 'ParserError20';
                        error.parserContext = { input: this.str, pos: this.pos + i, chr };
                        throw error;
                    }

                    if (!imapFormalSyntax.DIGIT().includes(chr) && chr !== '.') {
                        let error: ImapFlowError = new Error(`Unexpected char at position ${this.pos + i} [E21: ${JSON.stringify(chr)}]`);
                        error.code = 'ParserError21';
                        error.parserContext = { input: this.str, pos: this.pos + i, chr };
                        throw error;
                    }

                    if (tokenLast === '0' && (tokenLength === 1 || tokenPrev === '.') && chr !== '.') {
                        let error: ImapFlowError = new Error(`Invalid partial at position ${this.pos + i} [E22: ${JSON.stringify(chr)}]`);
                        error.code = 'ParserError22';
                        error.parserContext = { input: this.str, pos: this.pos + i, chr };
                        throw error;
                    }

                    appendToToken(chr);
                    break;

                case STATE_LITERAL:
                    if (this.currentNode.started) {
                        // only relevant if literals are not already parsed out from input

                        // Disabled NULL byte check
                        // See https://github.com/emailjs/emailjs-imap-handler/commit/f11b2822bedabe492236e8263afc630134a3c41c
                        /*
                        if (chr === '\u0000') {
                            throw new Error('Unexpected \\x00 at position ' + (this.pos + i));
                        }
                        */

                        this.currentNode.chBuffer![this.currentNode.chPos!++] = chr.charCodeAt(0);

                        if (this.currentNode.chPos! >= (this.currentNode.literalLength as number)) {
                            this.currentNode.endPos = this.pos + i;
                            this.currentNode.isClosed = true;
                            this.currentNode.value = this.currentNode.chBuffer!.toString('binary');
                            this.currentNode.chBuffer = Buffer.alloc(0);
                            this.currentNode = this.currentNode.parentNode!;
                            this.state = STATE_NORMAL;
                            checkSP();
                        }
                        break;
                    }

                    if (chr === '+' && this.options.literalPlus) {
                        this.currentNode.literalPlus = true;
                        break;
                    }

                    if (chr === '}') {
                        if (!('literalLength' in this.currentNode)) {
                            let error: ImapFlowError = new Error(`Unexpected literal prefix end char } at position ${this.pos + i} [E23]`);
                            error.code = 'ParserError23';
                            error.parserContext = { input: this.str, pos: this.pos + i, chr };
                            throw error;
                        }
                        if (this.str.charAt(i + 1) === '\n') {
                            i++;
                        } else if (this.str.charAt(i + 1) === '\r' && this.str.charAt(i + 2) === '\n') {
                            i += 2;
                        } else {
                            let error: ImapFlowError = new Error(`Unexpected char at position ${this.pos + i} [E24: ${JSON.stringify(chr)}]`);
                            error.code = 'ParserError24';
                            error.parserContext = { input: this.str, pos: this.pos + i, chr };
                            throw error;
                        }

                        this.currentNode.literalLength = Number(this.currentNode.literalLength);

                        if (!this.currentNode.literalLength) {
                            // special case where literal content length is 0
                            // close the node right away, do not wait for additional input
                            if (this.options.literals) {
                                // consume the queue entry of the {0} marker too, so later
                                // literals in the same response stay aligned with their markers
                                this.currentNode.value = takeLiteral(this.options.literals);
                            }
                            this.currentNode.endPos = this.pos + i;
                            this.currentNode.isClosed = true;
                            this.currentNode = this.currentNode.parentNode!;
                            this.state = STATE_NORMAL;
                            checkSP();
                        } else if (this.options.literals) {
                            // use the next precached literal values
                            this.currentNode.value = takeLiteral(this.options.literals);

                            // only APPEND arguments are kept as Buffers
                            /*
                            if ((this.parent.command || '').toString().toUpperCase() !== 'APPEND') {
                                this.currentNode.value = this.currentNode.value.toString('binary');
                            }
                            */

                            this.currentNode.endPos = this.pos + i + this.currentNode.value.length;

                            this.currentNode.started = false;
                            this.currentNode.isClosed = true;
                            this.currentNode = this.currentNode.parentNode!;
                            this.state = STATE_NORMAL;
                            checkSP();
                        } else {
                            // No pre-parsed literal buffers were supplied, so the literal is read
                            // inline from this input and its declared length decides an
                            // allocation. ImapStream always supplies buffers (and has already
                            // enforced its own cap), so this branch means the parser is being used
                            // directly and the declared length is untrusted: bound it before
                            // allocating anything.
                            // Two bounds apply: the configured maximum, and the bytes actually
                            // available here - an inline literal has to be present in the input
                            // being parsed, so a longer declaration can never be satisfied and
                            // must not reserve memory for itself.
                            let available = this.str.length - i - 1;
                            let literalLength = this.currentNode.literalLength;
                            if (literalLength > this.maxLiteralSize || literalLength > available) {
                                let overMax = literalLength > this.maxLiteralSize;
                                let error = createLiteralTooLargeError(
                                    literalLength,
                                    overMax ? this.maxLiteralSize : available,
                                    overMax ? null : `the ${available} bytes available in the input`
                                );
                                error.parserContext = { input: this.str, pos: this.pos + i, chr };
                                throw error;
                            }

                            this.currentNode.started = true;
                            // Allocate expected size buffer.
                            // Maybe should use allocUnsafe instead?
                            this.currentNode.chBuffer = Buffer.alloc(this.currentNode.literalLength);
                            this.currentNode.chPos = 0;
                        }
                        break;
                    }
                    if (!imapFormalSyntax.DIGIT().includes(chr)) {
                        let error: ImapFlowError = new Error(`Unexpected char at position ${this.pos + i} [E25: ${JSON.stringify(chr)}]`);
                        error.code = 'ParserError25';
                        error.parserContext = { input: this.str, pos: this.pos + i, chr };
                        throw error;
                    }
                    if (this.currentNode.literalLength === '0') {
                        let error: ImapFlowError = new Error(`Invalid literal at position ${this.pos + i} [E26]`);
                        error.code = 'ParserError26';
                        error.parserContext = { input: this.str, pos: this.pos + i, chr };
                        throw error;
                    }
                    this.currentNode.literalLength = (this.currentNode.literalLength || '') + chr;
                    break;

                case STATE_SEQUENCE: {
                    // A space ends the sequence set, and so does the closing delimiter of the
                    // enclosing list or section ("PARTIAL (1:100 5,7,9)", "[COPYUID 1 1:3 4,5]")
                    let closesParent = closesNode(chr, this.currentNode.parentNode);

                    if (chr === ' ' || closesParent) {
                        if (!RE_SINGLE_DIGIT.test(tokenLast) && tokenLast !== '*') {
                            if (!tokenHasStar) {
                                // a dangling separator, "10:" or "1,"
                                continueAsAtom();
                                break;
                            }
                            let error: ImapFlowError = new Error(`Unexpected end of sequence at position ${this.pos + i} [E27: ${JSON.stringify(chr)}]`);
                            error.code = 'ParserError27';
                            error.parserContext = { input: this.str, pos: this.pos + i, chr };
                            throw error;
                        }

                        if (this.currentNode.value !== '*' && tokenLast === '*' && tokenPrev !== ':') {
                            let error: ImapFlowError = new Error(`Unexpected end of sequence at position ${this.pos + i} [E28: ${JSON.stringify(chr)}]`);
                            error.code = 'ParserError28';
                            error.parserContext = { input: this.str, pos: this.pos + i, chr };
                            throw error;
                        }

                        this.currentNode.isClosed = true;
                        this.currentNode.endPos = this.pos + i - 1;
                        this.currentNode = this.currentNode.parentNode!;
                        this.state = STATE_NORMAL;

                        if (closesParent) {
                            this.currentNode.isClosed = true;
                            this.currentNode.endPos = this.pos + i;
                            this.currentNode = this.currentNode.parentNode!;
                            checkSP();
                        }
                        break;
                    }

                    if (chr === ':') {
                        if (!RE_SINGLE_DIGIT.test(tokenLast) && tokenLast !== '*') {
                            if (!tokenHasStar) {
                                continueAsAtom();
                                break;
                            }
                            let error: ImapFlowError = new Error(`Unexpected range separator : at position ${this.pos + i} [E29]`);
                            error.code = 'ParserError29';
                            error.parserContext = { input: this.str, pos: this.pos + i, chr };
                            throw error;
                        }
                    } else if (chr === '*') {
                        if (![',', ':'].includes(tokenLast)) {
                            let error: ImapFlowError = new Error(`Unexpected range wildcard at position ${this.pos + i} [E30]`);
                            error.code = 'ParserError30';
                            error.parserContext = { input: this.str, pos: this.pos + i, chr };
                            throw error;
                        }
                    } else if (chr === ',') {
                        if (!RE_SINGLE_DIGIT.test(tokenLast) && tokenLast !== '*') {
                            if (!tokenHasStar) {
                                continueAsAtom();
                                break;
                            }
                            let error: ImapFlowError = new Error(`Unexpected sequence separator , at position ${this.pos + i} [E31]`);
                            error.code = 'ParserError31';
                            error.parserContext = { input: this.str, pos: this.pos + i, chr };
                            throw error;
                        }
                        if (tokenLast === '*' && tokenPrev !== ':') {
                            let error: ImapFlowError = new Error(`Unexpected sequence separator , at position ${this.pos + i} [E32]`);
                            error.code = 'ParserError32';
                            error.parserContext = { input: this.str, pos: this.pos + i, chr };
                            throw error;
                        }
                    } else if (!RE_SINGLE_DIGIT.test(chr)) {
                        if (!tokenHasStar) {
                            continueAsAtom();
                            break;
                        }
                        let error: ImapFlowError = new Error(`Unexpected char at position ${this.pos + i} [E33: ${JSON.stringify(chr)}]`);
                        error.code = 'ParserError33';
                        error.parserContext = { input: this.str, pos: this.pos + i, chr };
                        throw error;
                    }

                    if (RE_SINGLE_DIGIT.test(chr) && tokenLast === '*') {
                        let error: ImapFlowError = new Error(`Unexpected number at position ${this.pos + i} [E34: ${JSON.stringify(chr)}]`);
                        error.code = 'ParserError34';
                        error.parserContext = { input: this.str, pos: this.pos + i, chr };
                        throw error;
                    }

                    appendToToken(chr);
                    break;
                }
            }
        }

        // the same applies to a digit-led token that ends the input on a dangling separator ("10:")
        if (this.state === STATE_SEQUENCE && (tokenLast === ':' || tokenLast === ',') && !tokenHasStar) {
            this.currentNode.type = 'ATOM';
        }

        // A star-led sequence set ("*:4") is only closed by a space or a closing delimiter, so one
        // that ends the input is closed here, under the same rules a space applies to it. A bare "*"
        // is left to getAttributes(), which reads it as an atom
        if (this.state === STATE_SEQUENCE && !this.currentNode.isClosed && (RE_SINGLE_DIGIT.test(tokenLast) || (tokenLast === '*' && tokenPrev === ':'))) {
            this.currentNode.isClosed = true;
            this.currentNode.endPos = this.pos + this.str.length - 1;
        }
    }
}
