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

module.exports = function test() {
    var self = this;

    describe('import with metaInfo', function() {
        var oldConfig;
        var oldMetaInfo;

        before('reset test property', function(done) {
            self.worker.setProperty({
                id: 'test.aValue',
                value: 555
            }, done);
        });

        it('should export config with metaInfo and where filter',
                function(done) {
            self.worker.exportConfiguration({
                includeMetaInfo: true,
                where: {
                    module: 'test'
                }
            }, function(err, res) {
                assert.ifError(err);

                data = JSON.parse(res);
                assert.equal(data.modules.length, 1);

                oldConfig = data;

                assert.equal(oldConfig.modules[0].id, 'test');
                assert(oldConfig.modules[0].properties);
                assert(oldConfig.modules[0].propertiesMetaInfo);

                oldMetaInfo = oldConfig.modules[0].propertiesMetaInfo.aValue;
                assert(oldMetaInfo.version);
                assert(oldMetaInfo.updatedAt);

                done();
            });
        });

        it('should update property value', function(done) {
            self.worker.setProperty({
                id: 'test.aValue',
                value: 555,
                persistent: true
            }, done);
        });

        it('should check that metaInfo updated', function(done) {
            self.worker.findProperties({
                where: {
                    id: 'test.aValue'
                }
            }, function(err, res) {
                assert.ifError(err);
                assert(res[0].version > oldMetaInfo.version);
                assert(res[0].updatedAt > oldMetaInfo.updatedAt);
                done();
            });
        });

        it('should import old config w/o overwriting meta info',
                function(done) {
            self.worker.importConfiguration({
                configuration: JSON.stringify(oldConfig),
                overwriteMetaInfo: false
            }, done);
        });

        it('importing job should finish successfully', function(done) {
            self.waitForImportJob('done', done);
        });

        it('should check that metaInfo is reverted', function(done) {
            self.worker.findProperties({
                where: {
                    id: 'test.aValue'
                }
            }, function(err, res) {
                assert.ifError(err);
                assert(res[0].version > oldMetaInfo.version);
                assert(res[0].updatedAt > oldMetaInfo.updatedAt);
                done();
            });
        });

        it('should import old config WITH overwriting meta info',
                function(done) {
            self.worker.importConfiguration({
                configuration: JSON.stringify(oldConfig),
                overwriteMetaInfo: true
            }, done);
        });

        it('importing job should finish successfully', function(done) {
            self.waitForImportJob('done', done);
        });

        it('should check that metaInfo is reverted', function(done) {
            self.worker.findProperties({
                where: {
                    id: 'test.aValue'
                }
            }, function(err, res) {
                assert.ifError(err);
                assert.equal(res[0].version, oldMetaInfo.version);
                assert.equal(res[0].updatedAt, oldMetaInfo.updatedAt);
                done();
            });
        });

    });

    describe('import with wrong metaInfo', function() {
        var addSecs = 24 * 60 * 60; // one day
        var futureTime = new Date(new Date().getTime() + addSecs * 1000);
        var oldMetaInfo;

        var futureConfig = {
            version: 1,
            modules: [
                {
                    id: 'test',
                    meta: {
                        version: 1,
                    },
                    properties: {
                        aValue: 777
                    },
                    propertiesMetaInfo: {
                        aValue: {
                            version: 1,
                            updatedAt: futureTime.toISOString()
                        }
                    }
                }
            ]
        };

        it('should update property value', function(done) {
            self.worker.setProperty({
                id: 'test.aValue',
                value: 555,
                persistent: true
            }, done);
        });

        it('should get current metaInfo updated', function(done) {
            self.worker.findProperties({
                where: {
                    id: 'test.aValue'
                }
            }, function(err, res) {
                assert.ifError(err);
                oldMetaInfo = res[0];
                done();
            });
        });

        it('should import future config with overwriting meta info',
                function(done) {
            self.worker.importConfiguration({
                configuration: JSON.stringify(futureConfig),
                overwriteMetaInfo: true
            }, done);
        });

        it('importing job should finish successfully', function(done) {
            self.waitForImportJob('done', done);
        });

        it('should check that metaInfo is updated but not future',
                function(done) {
            self.worker.findProperties({
                where: {
                    id: 'test.aValue'
                }
            }, function(err, res) {
                assert.ifError(err);

                // version should be overwritten
                assert.equal(res[0].version, 1);

                // updateAt should be updated to "now", not to future
                var now = new Date().toISOString();
                assert(res[0].updatedAt > oldMetaInfo.updatedAt);
                assert(res[0].updatedAt < now);
                assert(futureTime.toISOString() > now);
                done();
            });
        });
    });

};

