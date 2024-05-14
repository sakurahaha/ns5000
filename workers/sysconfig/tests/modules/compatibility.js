var assert = require('assert');
var nefUtils = require('nef/utils');
var testHelpers = require('nef/testHelpers');

module.exports = function test() {
    var self = this;

    describe('v=1.0', function() {
        it('should find props for ver = 1.0', function(done) {
            findAssert({
                apiVersion: '1.0',
                expectNames: ['compatV10'],
                expectMissedNames: ['compatV11'],
                expectPublicNames: ['test.compat'],
                expectMissingPublicNames: ['test.newCompat'],
            }, done);
        });

        it('should get v1.0 prop by publicName', function(done) {
            self.worker.getProperty({
                publicName: 'test.compat',
                apiVersion: '1.0'
            }, (err, res) => {
                assert.ifError(err);
                assert.equal(res, 'v1.0');
                done();
            });
        });

        it('should not get v1.1 prop by id', function(done) {
            self.worker.getProperty({
                id: 'test.compatV11',
                apiVersion: '1.0'
            }, (err, res) => {
                assert.errorIs('ENOENT', err);
                done();
            });

        });

        it('should not get v1.2 prop by publicName', function(done) {
            self.worker.getProperty({
                publicName: 'test.newCompat',
                apiVersion: '1.0'
            }, (err, res) => {
                assert.errorIs('ENOENT', err);
                done();
            });

        });

        it('should be able to update old prop', function(done) {
            self.worker.setProperty({
                publicName: 'test.compat',
                apiVersion: '1.0',
                value: 'someValue'
            }, done);
        });

        it('should not be able to update new props', function(done) {
            self.worker.setProperty({
                publicName: 'test.newCompat',
                apiVersion: '1.0',
                value: 'someValue'
            }, (err, res) => {
                assert.errorIs('ENOENT', err);
                done();
            });
        });
    });

    for (apiVer of ['1.1', '1.2', undefined]) {
        describe(`v=${apiVer}`, function() {
            it(`should find props for ver = ${apiVer}`, function(done) {
                findAssert({
                    apiVersion: apiVer,
                    expectNames: ['compatV11'],
                    expectMissedNames: ['compatV10'],
                    expectPublicNames: ['test.newCompat'],
                    expectMissingPublicNames: ['test.compat'],
                }, done);
            });

            it('should NOT get v1.0 prop by publicName', function(done) {
                self.worker.getProperty({
                    publicName: 'test.compat',
                    apiVersion: apiVer
                }, (err, res) => {
                    assert.errorIs('ENOENT', err);
                    done();
                });
            });

            it('should get v1.1 prop by id', function(done) {
                self.worker.getProperty({
                    id: 'test.compatV11',
                    apiVersion: apiVer
                }, (err, res) => {
                    assert.ifError(err);
                    assert.equal(res, 'v1.1');
                    done();
                });

            });

            it('should get v1.1 prop by publicName', function(done) {
                self.worker.getProperty({
                    publicName: 'test.newCompat',
                    apiVersion: apiVer
                }, (err, res) => {
                    assert.ifError(err);
                    assert.equal(res, 'v1.1');
                    done();
                });

            });

            it('should be able to update old prop', function(done) {
                self.worker.setProperty({
                    publicName: 'test.compat',
                    apiVersion: apiVer,
                    value: 'someValue'
                }, (err, res) => {
                    assert.errorIs('ENOENT', err);
                    done();
                });
            });

            it('should not be able to update new props', function(done) {
                self.worker.setProperty({
                    publicName: 'test.newCompat',
                    apiVersion: apiVer,
                    value: 'someValue'
                }, done);
            });
        });
    }

    //
    // Helpers
    //
    function findAssert(opts, done) {
        self.worker.findProperties({
            where: {
                module: 'test'
            },
            apiVersion: opts.apiVersion,
        }, (err, res) => {
            assert.ifError(err);
            shouldBeThere(opts.expectNames,
                          res, 'name');
            shouldBeThere(opts.expectPublicNames,
                          res, 'publicName');
            shouldNotBeThere(opts.expectMissedNames,
                             res, 'name');
            shouldNotBeThere(opts.expectMissingPublicNames,
                             res, 'publicName');
            done();
        });
    }

    function shouldBeThere(expected, result, key) {
        if (!expected) {
            return;
        }

        var weHave = nefUtils.arrayToDict(result, key);
        for (el of expected) {
            assert(el in weHave, `property with ${key}=${el} ` +
                                 'should be in result');
        }
    }

    function shouldNotBeThere(expected, result, key) {
        if (!expected) {
            return;
        }

        var weHave = nefUtils.arrayToDict(result, key);
        for (el of expected) {
            assert(!(el in weHave), `property with ${key}=${el} ` +
                                    'should NOT be in result');
        }
    }

};
