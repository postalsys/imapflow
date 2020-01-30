'use strict';

// Utility script to build TypeScript typings

const { exec } = require('child_process');
const fs = require('fs');

const path = 'lib/types.d.ts';

// Generate lib/types.d.ts
exec('jsdoc -t node_modules/tsd-jsdoc/dist -r lib/imap-flow.js --destination lib/', (err, stdout, stderr) => {
    if (err) {
        console.error(err);
        return process.exit(1);
    }
    stderr = (stderr || '').trim();
    if (stderr) {
        console.error(stderr);
    }

    // lib/types.d.ts uses EVentEmitter so we need to reference it from node typings

    fs.stat(path, (err, stats) => {
        if (err) {
            console.error(err);
            return process.exit(1);
        }
        if (!stats || !stats.isFile()) {
            console.error(`${path} is not a file`);
            return process.exit(1);
        }

        fs.readFile(path, 'utf-8', (err, content) => {
            if (err) {
                console.error(err);
                return process.exit(1);
            }

            // make sure node types are referenced
            content = '/// <reference types="node" />\n\n' + content;

            // inject EventEmitter definitions from node typings
            content = content.replace(/(declare module[^\n]+)/, '$1\n    import { EventEmitter } from "events";\n');

            // path tls object to allow undocumented keys
            content = content.replace(/(tls: \{[^\n]*)/, '$1\n                [prop: string]: any;\n            } & {');

            fs.writeFile(path, Buffer.from(content), err => {
                if (err) {
                    console.error(err);
                    return process.exit(1);
                }
            });
        });
    });
});
