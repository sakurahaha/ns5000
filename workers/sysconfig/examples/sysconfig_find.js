/*
 * Shows how to list all available parameters
 */

var Client = require('nef/client');
var assert = require('assert');
var async = require('async');

// Connect to NEF
var client = new Client('1.0', 'tcp://127.0.0.1:5557');

// Connect to sysconfig worker
client.worker('sysconfig', function (err, sysconfig) {
    assert.ifError(err);

    async.series([
        function (done) {
            // List several properties
            sysconfig.findProperties({
                where: {
                    idIn: ['hardware.memory', 'unix.time'],
                },
            }, function (err, vals) {
                assert.ifError(err);

                for (var i = 0; i < vals.length ; i++ ) {
                    var prop = vals[i];
                    console.log('  ' + prop.id + ' - ' + JSON.stringify(prop.description));
                }

                done();
            });
        },
        function (done) {
           // List all parameters of zfs worker
            console.log('----------------');
            sysconfig.findProperties({
                where: {
                    module: 'kernel',
                },
            }, function (err, vals) {
                assert.ifError(err);

                for (var i = 0; i < vals.length ; i++ ) {
                    var prop = vals[i];
                    console.log('  ' + prop.id + ' - ' + JSON.stringify(prop.description));
                }

                done();
            });
        },
        function (done) {
            // List all parameters containing "version" word
            console.log('----------------');
            sysconfig.findProperties({
                where: {
                    descriptionMatches: 'version',
                },
            }, function (err, vals) {
                assert.ifError(err);

                for (var i = 0; i < vals.length ; i++ ) {
                    var prop = vals[i];
                    console.log('  ' + prop.id + ' - ' + JSON.stringify(prop.description));
                }

                done();
            });
        }
    ], function () {
        // Disconnect from NEF
        client.disconnect();
    });
});
