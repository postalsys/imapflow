'use strict';

module.exports = function (grunt) {
    // Project configuration.
    grunt.initConfig({
        eslint: {
            all: ['lib/**/*.js', 'test/**/*.js', 'Gruntfile.js']
        },

        nodeunit: {
            // test/integration is excluded: those tests need a live Docker server
            // and run via `npm run test:rev2` instead
            all: ['test/**/*-test.js', '!test/integration/**']
        }
    });

    // Load the plugin(s)
    grunt.loadNpmTasks('grunt-eslint');
    grunt.loadNpmTasks('grunt-contrib-nodeunit');

    // Tasks
    grunt.registerTask('default', ['eslint', 'nodeunit']);
};
