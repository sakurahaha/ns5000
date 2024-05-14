/*
 * Shows how to list all available properties
 */

var Client = require('nef/client');
var assert = require('assert');
var async = require('async');

// Connect to NEF
var client = new Client('1.0', 'tcp://127.0.0.1:5557');

// Connect to sysconfig worker
client.worker('sysconfig', function (err, sysconfig) {
    assert.ifError(err);

    // Query list of available properties
    sysconfig.findProperties({}, function (err, props) {
        assert.ifError(err);

        for (var i = 0; i < props.length; i++) {
            var prop = props[i];
            console.log('    ' + prop.id + ' - ' + JSON.stringify(prop.description));
        }
        client.disconnect();
    });
});
