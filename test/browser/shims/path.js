// path in the browser bundle: mailsplit takes the extension of an attachment file name with
// path.parse()

export function parse(file) {
    const base = String(file).split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot) : '';
    return { root: '', dir: '', base, ext, name: ext ? base.slice(0, dot) : base };
}

export default { parse };
