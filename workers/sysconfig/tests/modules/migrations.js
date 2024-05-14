/*
 * This BDD test tests importing job and migrations at the same time
 *
 * Copyright (C) 2013 Nexenta Systems, Inc
 * All rights reserved.
 *
 */

var assert = require('assert');
var async = require('async');
var util = require('util');
var nefUtils = require('nef/utils');

module.exports = function test() {
    var self = this;
    function genConfig(opts) {
        var opts = opts || {};
        return {
            version: 1,
            modules: [
                {
                    id: opts.module || 'test',
                    meta: {
                        version: opts.version || 1
                    },
                    properties: opts.properties || {}
                }
            ]
        };
    }

    function doImportConfig(config, done) {
        async.series([
            next => {
                self.worker.importConfiguration({
                    configuration: JSON.stringify(config)
                }, function(err, res) {
                    assert.ifError(err);
                    next();
                });
            },
            next => {
                self.waitForImportJob('done', next);
            }
        ], done);
    }

    function checkValues(filter, done) {
        self.worker.findProperties({
            where: filter,
            includeValues: true
        }, (err, lst) => {
            assert.ifError(err);
            var res = nefUtils.arrayToDict(lst, 'id', 'currentValue');
            done(undefined, res);
        });
    }

    describe('importing with migrations', function() {
        var oldConfig = genConfig({
            module: 'test',
            version: 1,
            properties: {
                aList: ['imported'],
                oldValue: 10,
                shouldBeRemoved: 12,

            }
        });

        var defaults = {
            aList: ['test'],
            aValue: 5,
        };

        it('should set default values', function(done) {
            async.forEach(Object.keys(defaults), function(param, next) {
                self.worker.setProperty({
                    id: 'test.' + param,
                    value: defaults[param]
                }, function(err) {
                    assert.ifError(err);
                    next();
                });
            }, done);
        });

        it('should get and verify default values', function(done) {
            async.forEach(Object.keys(defaults), function(param, next) {
                self.worker.getProperty({
                    id: 'test.' + param,
                }, function(err, value) {
                    assert.ifError(err);
                    assert.deepEqual(value, defaults[param]);
                    next();
                });
            }, done);
        });

        it('should start importing job', function(done) {
            doImportConfig(oldConfig, done);
        });

        it('should get new values for imported props', function(done) {
            checkValues({
                module: 'test'
            }, (err, res) => {
                assert.deepEqual(res['test.aList'],
                                 ['imported', 'added in migration']);
                assert.equal(res['test.aValue'], 25);
                done();
            });
        });
    });

    describe('nefModule migrations', function() {
        function cleanupProps(done) {
            self.worker.bulkSetProperties({
                pairs: {
                    'nef.webProxy': null,
                    'nef.webProxyPassword': null
                },
                persistent: true
            }, done);
        }

        after('cleanup props', cleanupProps);

        describe('from1to2 w/o pass', function() {
            before('cleanup props', cleanupProps);

            it('should import config with url without pass', function(done) {
                doImportConfig(genConfig({
                    module: 'nef',
                    version: 1,
                    properties: {
                        webProxy: 'http://user@host.com/user:pass/'
                    }
                }), done);

            });

            it('should get check webProxy value', function(done) {
                checkValues({
                    module: 'nef'
                }, (err, res) => {
                    assert.equal(res['nef.webProxy'],
                                 'http://user@host.com/user:pass/');
                    assert.equal(res['nef.webProxyPassword'], undefined);
                    done();
                });
            });
        });

        describe('from1to2 with pass', function() {
            before('cleanup props', cleanupProps);

            it('should import config with url without pass', function(done) {
                doImportConfig(genConfig({
                    module: 'nef',
                    version: 1,
                    properties: {
                        webProxy: 'http://user:pass@host.com/user:pass/'
                    }
                }), done);

            });

            it('should get check webProxy value', function(done) {
                checkValues({
                    module: 'nef'
                }, (err, res) => {
                    assert.equal(res['nef.webProxy'],
                                 'http://user@host.com/user:pass/');
                    assert.equal(res['nef.webProxyPassword'],
                                 'pass');
                    done();
                });
            });
        });

        describe('from1to2 with another pass', function() {
            before('cleanup props', cleanupProps);

            it('should import config with url without pass', function(done) {
                doImportConfig(genConfig({
                    module: 'nef',
                    version: 1,
                    properties: {
                        webProxy: 'http://user:pass@host.com/user:pass/',
                        webProxyPassword: 'anotherpass'
                    }
                }), done);
            });

            it('should get check webProxy value', function(done) {
                checkValues({
                    module: 'nef'
                }, (err, res) => {
                    // password should not be removed
                    // if there is another pass in webProxyPassword
                    assert.equal(res['nef.webProxy'],
                                 'http://user:pass@host.com/user:pass/');

                    // password prop should contain old pass
                    assert.equal(res['nef.webProxyPassword'],
                                 'anotherpass');
                    done();
                });
            });
        });
    });
};
