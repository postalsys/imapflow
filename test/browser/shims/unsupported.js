// node:net, node:tls, node:dns and node:zlib in the browser bundle. Sessions connect through the
// transport option, so the socket modules are loaded but never called. node:zlib has no
// createDeflateRaw, so ImapFlow skips COMPRESS

const unsupported = name => () => {
    throw new Error(name + ' is not available in the browser');
};

export const connect = unsupported('connect()');
export const isIP = unsupported('isIP()');
export const lookup = unsupported('lookup()');
export const promises = { lookup: unsupported('lookup()') };
export const constants = {};

export default { connect, isIP, lookup, promises, constants };
