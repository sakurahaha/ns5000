/*
 * Snapping worker BDD tests.
 *
 * Copyright (C) 2013 Nexenta Systems, Inc
 * All rights reserved.
 *
 */

var assert = require('assert');
var async = require('async');
var colors = require('colors');
var Client = require('nef/client');
var nefUtils = require('nef/utils');
var testConfig = nefUtils.requireConfig('testConfig/sysconfig');
var events = require('nef/events');
var testHelpers = require('nef/testHelpers');

var modules = [
    'base',
    'elementModifications',
    'importing',
    'importingMetaInfo',
    'migrations',
    'service',
    'upgrade',
    'watcher',
    'rebootNeeded',
    'compatibility',
    'rollback',
    'context',
    'certificate'
];

describe('sysconfig', function() {
    var client;
    var ctx = {};

    testHelpers.initSuite(this, {
        tag: 'vm'
    });

    ctx.waitForImportJob = function waitForImportJob(expect, done) {
        var ended = false;
        var iteration = 0;
        var lastRes = 'undefined';
        async.whilst(
            function testEnd() {
                return !ended && (iteration++ < testConfig.waitTries);
            },
            function checkJob(next) {
                ctx.worker.getJobStatus({}, function(err, res) {
                    assert.ifError(err);
                    lastRes = res;
                    if (res.status === 'done' || res.status === 'failed') {
                        ended = true;
                        next();
                    } else {
                        setTimeout(next, testConfig.waitInterval);
                    }
                });
            },
            function lastCheck(err) {
                assert.ifError(err);
                assert.equal(lastRes.status, expect);
                done();
            }
        );
    };

    before(function(done) {
        client = new Client('1.0', 'tcp://127.0.0.1:5557', {
            validateOutput: true
        });
        async.parallel([
            events.preconnect.bind(events),
            function(done) {
                client.worker('sysconfig', function(err, val) {
                    assert.ifError(err);
                    ctx.worker = val;
                    done();
                });
            },
        ], done);
    });

    after(function(done) {
        ctx.worker.call('coverageReport', {}, function(err, val) {
            if (err && err.code === 'COVERAGE-ERROR') {
                console.log('\n', err.toString());
            } else if (err) {
                assert.ifError(err);
            } else {
                console.log('\nCode coverage report saved at: ', val);
            }
            client.disconnect();
            done();
        });
    });

    for (var i = 0; i < modules.length; i++) {
        var module = require('./modules/' + modules[i]);
        describe(modules[i], function() {
            module.apply(ctx, []);
        });
    }
});
