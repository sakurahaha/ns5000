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
    var data;

    async.series([
        function (done) {
            // Get entire configuration in JSON format
            sysconfig.exportConfiguration(function (err, val) {
                assert.ifError(err)
                data = val;
                console.log(val);
                done();
            });
        },
        function (done) {
            // Replace configuration with supplied JSON data
            sysconfig.importConfiguration({
                configuration: data
            }, function (err) {
                assert.ifError(err);
                done();
            });
        }
    ], function () {
        // Disconnect from NEF
        client.disconnect();
    });
});
