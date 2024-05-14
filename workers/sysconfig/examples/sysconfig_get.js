/*
 * Shows how to get property values directly from sysconfig worker
 */

var Client = require('nef/client');
var assert = require('assert');
var async = require('async');

// Connect to NEF
var client = new Client('1.0', 'tcp://127.0.0.1:5557');

// Connect to sysconfig worker
client.worker('sysconfig', function (err, sysconfig) {
    assert.ifError(err);

    // Get one value
    sysconfig.getProperty({
        module: 'hardware',
        name: 'memory',
    }, function (err, val) {
        assert.ifError(err);
        console.log('Memory is "' + val);
        client.disconnect();
    });
});

