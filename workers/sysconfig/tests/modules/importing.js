/*
 * This BDD test tests importing job and it's error handling
 *
 * Copyright (C) 2013 Nexenta Systems, Inc
 * All rights reserved.
 *
 */

var assert = require('assert');
var async = require('async');
var Client = require('nef/client');
var util = require('util');
var testHelpers = require('nef/testHelpers');

module.exports = function test() {
    var self = this;

    describe('importing future configs', function() {

        it('should not import config from future', function(done) {
            var futureConfig = {
                version: 9999,
                modules: []
            };

            self.worker.importConfiguration({
                configuration: JSON.stringify(futureConfig)
            }, function(err) {
                assert(err);
                done();
            });
        });

        it('should not import config with module from future', function(done) {
            var futureConfig = {
                version: 1,
                modules: [
                    {
                        id: 'test',
                        meta: {
                            version: 9999,
                        },
                        properties: {},
                    }
                ]
            };

            self.worker.importConfiguration({
                configuration: JSON.stringify(futureConfig)
            }, function(err) {
                assert.ifError(err);
                done();
            });
        });

        it('import job should fail at the end', function(done) {
            self.waitForImportJob('failed', done);
        });
    });

    describe('importing wrong value types', function() {

        it('should not import config with wrong value type', function(done) {
            var wrongConfig = {
                version: 1,
                modules: [
                    {
                        id: 'test',
                        meta: {
                            version: 1,
                        },
                        properties: {
                            aValue: 'wrong',
                        },
                    }
                ]
            };

            self.worker.importConfiguration({
                configuration: JSON.stringify(wrongConfig)
            }, function(err) {
                assert.ifError(err);
                done();
            });
        });

        it('import job should fail at the end', function(done) {
            self.waitForImportJob('failed', done);
        });
    });

    describe('importing events', () => {

        it('should generate event during import', (done) => {
            var config = {
                version: 1,
                modules: [
                    {
                        id: 'test',
                        meta: {
                            version: 1
                        },
                        properties: {
                            aValue: 123
                        },
                    }
                ]
            };

            testHelpers.waitEvent({
                event: 'NEF_sysconfig_set_param',
                done: done,
                delay: 500,
                prepare(cb) {
                    self.worker.importConfiguration({
                        configuration: JSON.stringify(config),
                        context: 'Test run',
                    }, cb);
                },
                filter(evt) {
                    return evt.id == 'test.aValue';
                },
                process(evt, cb) {
                    assert.equal(evt.context.name, 'Test run');
                    assert.equal(evt.context.type, 'restore');
                    assert.deepEqual(evt.value, 123);
                    cb();
                }
            });
        });

        it('import job should successfully import', function(done) {
            self.waitForImportJob('done', done);
        });
    });
};

