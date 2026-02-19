'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const prettierConfig = require('eslint-config-prettier/flat');
const nodemailerConfig = require('eslint-config-nodemailer');

module.exports = [
    {
        ignores: ['node_modules/**', 'examples/**', 'docs/**']
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            parserOptions: {
                ecmaFeatures: {
                    globalReturn: true
                }
            },
            globals: {
                ...globals.node,
                ...globals.es2021,
                it: 'readonly',
                describe: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly'
            }
        },
        rules: {
            ...nodemailerConfig.rules,
            'no-await-in-loop': 0,
            'require-atomic-updates': 0
        }
    },
    prettierConfig,
    {
        files: ['eslint.config.js', '.prettierrc.js', '.ncurc.js'],
        rules: {
            'global-require': 0,
            strict: 0
        }
    }
];
