'use strict';

const { FlatCompat } = require('@eslint/eslintrc');
const js = require('@eslint/js');

const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended
});

module.exports = [
    {
        ignores: ['node_modules/**', 'examples/**', 'docs/**']
    },
    ...compat.extends('nodemailer', 'prettier'),
    {
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: 'script',
            globals: {
                BigInt: 'readonly'
            },
            parser: require('@babel/eslint-parser'),
            parserOptions: {
                requireConfigFile: false
            }
        },
        plugins: {
            '@babel': require('@babel/eslint-plugin')
        },
        rules: {
            'no-await-in-loop': 0,
            'require-atomic-updates': 0
        }
    },
    {
        files: ['eslint.config.js', '.prettierrc.js', '.ncurc.js'],
        rules: {
            'global-require': 0,
            strict: 0
        }
    }
];
