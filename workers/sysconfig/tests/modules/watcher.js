var assert = require('assert');
var async = require('async');
var fs = require('fs');
var Client = require('nef/client');
var util = require('util');

var TMP_FILE = '/tmp/nef-test-config.0';

module.exports = function test() {
    var self = this;

    describe('watcher', function() {
        it('it should set value to test.storedValue', function(done) {
            self.worker.setProperty({
                id: 'test.stored',
                value: 'first',
                persistent: true,
            }, function(err, res) {
                assert.ifError(err);
                done();
            });
        });

        it('it should set value temporary', function(done) {
            self.worker.getProperty({
                id: 'test.stored',
                persistent: false,
            }, function(err, res) {
                assert.ifError(err);
                assert.equal(res, 'first');
                done();
            });
        });

        it('it should set value persistently', function(done) {
            self.worker.getProperty({
                id: 'test.stored',
                persistent: true,
            }, function(err, res) {
                assert.ifError(err);
                assert.equal(res, 'first');
                done();
            });
        });

        it('file for value should be updated', function(done) {
            fs.readFile(TMP_FILE, 'utf-8', function(err, data) {
                assert.ifError(err);
                assert.equal(data, 'first');
                done();
            });
        });

        it('update file ourself', function(done) {
            fs.writeFile(TMP_FILE, 'second', function(err) {
                assert.ifError(err);
                done();
            });
        });

        it('should update persistent value automatically', function(done) {
            var tries = 50;
            var interval = 100;
            var lastValue = undefined;
            async.whilst(
                function test() {
                    return (lastValue !== 'second') && (tries-- > 0);
                },
                function getCurrent(next) {
                    self.worker.getProperty({
                        id: 'test.stored',
                        persistent: true,
                    }, function(err, res) {
                        if (err) {
                            return next(err);
                        }
                        lastValue = res;

                        if (lastValue === 'second') {
                            next();
                        } else {
                            setTimeout(next, interval);
                        }
                    });
                },
                function end(err) {
                    assert.ifError(err);
                    assert.equal(lastValue, 'second');
                    done();
                }
            );
        });

        it('should NOT update temporary value', function(done) {
            // it because if file was changed, it does not means that
            // current (temporary) value is changed also. It should
            // be decided by worker

            self.worker.getProperty({
                id: 'test.stored',
                persistent: false,
            }, function(err, res) {
                assert.ifError(err);
                assert.equal(res, 'first');
                done();
            });
        });
    });
};
