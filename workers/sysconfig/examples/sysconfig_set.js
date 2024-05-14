/*
 * Shows how to set property values
 */

var Client = require('nef/client');
var assert = require('assert');
var async = require('async');

// Connect to NEF
var client = new Client('1.0', 'tcp://127.0.0.1:5557');

// Connect to sysconfig worker
client.worker('sysconfig', function (err, sysconfig) {
    assert.ifError(err);

    // Get some values
    sysconfig.setProperty({
	   module: 'test',
	   name : 'debug0',
       value: 'a test string',
    }, function (err) {
        assert.ifError(err);
        console.log('OK');
        client.disconnect();
    });
});
