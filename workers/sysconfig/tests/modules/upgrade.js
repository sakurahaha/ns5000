/*
 * This BDD tests for upgrading old databases during load
 *
 * Copyright (C) 2013 Nexenta Systems, Inc
 * All rights reserved.
 *
 */

var assert = require('assert');
var async = require('async');
var util = require('util');
var Storage = require('nef/sysconfig/Storage');
var testHelpers = require('nef/testHelpers');

module.exports = function test() {
    var self = this;
    var oldVersion = 1;
    var oldProperties = {
        aList: ['imported'],
        oldValue: 10,
        shouldBeRemoved: 12
    };
    var storage;

    describe('upgrading old database', function() {

        it('should wait for sysconfig stop', function(done) {
            testHelpers.waitWorkerStop('sysconfig', done);
        });

        it('should purge storage for test module', function(done) {
            storage = new Storage({
                id: 'db.' + 'test',
                migrator: undefined,
                version: oldVersion,
            });

            storage.purgeDatabase(done);
        });

        it('should seed storage with old values and set old version',
            function(done) {

                async.series([
                    storage.init.bind(storage),
                    function(next) {
                        async.forEach(Object.keys(oldProperties),
                                function(prop, next) {
                            storage.update(prop, {
                                value: oldProperties[prop]
                            }, next);
                        }, next);
                    },
                ], done);
            });

        it('should wait for sysconfig start', function(done) {
            testHelpers.waitWorkerStart('sysconfig', done);
        });

        it('should get new values for aList', function(done) {
            self.worker.getProperty({
                id: 'test.aList'
            }, function(err, res) {
                assert.ifError(err);

                // 10 from oldConfig + 15 from migration
                assert.deepEqual(res, ['imported', 'added in migration']);
                done();
            })
        });

        it('should get new values for aValue', function(done) {
            self.worker.getProperty({
                id: 'test.aValue'
            }, function(err, res) {
                assert.ifError(err);

                assert.equal(res, 25);
                done();
            })
        });
    });
};

