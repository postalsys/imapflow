// Sends a NO-OP command
export const NOOP = async connection => {
    try {
        let response = await connection.exec('NOOP', false, { comment: 'Requested by command' });
        response.next();
        return true;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
