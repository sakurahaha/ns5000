var async = require('async');
var expect = require('chai').expect;
var interop = require('nef/interop');
var nefUtils = require('nef/utils');

module.exports = function test() {
    var self = this;

    describe('rollback feature', function() {

        function checkResult(expected, done) {
            self.worker.findProperties({
                where: {
                    module: 'test'
                },
                includeValues: true
            }, (err, res) => {
                expect(err).success;

                props = nefUtils.arrayToDict(res, 'id');
                expect(props).to.have.property('test.rollbackTest');
                expect(props).to.have.property('test.rollbackMeter');

                var val = props['test.rollbackTest'];
                var meter = props['test.rollbackMeter'].currentValue;

                var rollbackCtx = meter.ctx || {};

                expect(val.currentValue).to.equal(expected.currentValue);
                expect(val.storedValue).to.equal(expected.storedValue);

                if (expected.rollbackErr !== undefined) {
                    expect(meter.err)
                           .to.equal(expected.rollbackErr);
                }

                if (expected.origValue !== undefined) {
                    expect(rollbackCtx.origValue)
                           .to.equal(expected.origValue);
                }

                if (expected.newValue !== undefined) {
                    expect(rollbackCtx.newValue)
                           .to.equal(expected.newValue);
                }

                if (expected.rollbackCalled !== undefined) {
                    expect(!!meter.called)
                           .to.equal(expected.rollbackCalled);
                }
                done();
            });

        }

        beforeEach('reset to normal settings', function(done) {
            async.series([
                (next) => self.worker.setProperty({
                    id: 'test.rollbackTest',
                    value: 'ok',
                    persistent: true
                }, next),

                (next) => checkResult({
                    currentValue: 'ok',
                    storedValue: 'ok',
                    rollbackCalled: false,
                }, next)
            ], done);
        });

        it('should rollback after error in normal setter ' +
           'with persistent=false', function(done) {
            async.series([
                (next) => self.worker.setProperty({
                    id: 'test.rollbackTest',
                    value: 'fail current',
                    persistent: false
                }, (err) => {
                    expect(err).to.have.errorCode('EBADARG');
                    next();
                }),

                (next) => checkResult({
                    currentValue: 'ok',
                    storedValue: 'ok',
                    rollbackCalled: true,
                    rollbackErr: 'EBADARG: Failure in current setter',
                    origValue: 'ok',
                    newValue: 'fail current'
                }, next)
            ], done);
        });

        it('should rollback after error in normal setter ' +
           'with persistent=false', function(done) {
            async.series([
                (next) => self.worker.setProperty({
                    id: 'test.rollbackTest',
                    value: 'fail current',
                    persistent: true
                }, (err) => {
                    expect(err).to.have.errorCode('EBADARG');
                    next();
                }),

                (next) => checkResult({
                    currentValue: 'ok',
                    storedValue: 'ok',
                    rollbackCalled: true,
                    rollbackErr: 'EBADARG: Failure in current setter',
                    origValue: 'ok',
                    newValue: 'fail current'
                }, next)
            ], done);
        });

        it('should NOT rollback after error in persistent setter ' +
           'with persistent=false', function(done) {
            async.series([
                (next) => self.worker.setProperty({
                    id: 'test.rollbackTest',
                    value: 'fail persistent',
                    persistent: false
                }, next),

                (next) => checkResult({
                    currentValue: 'fail persistent', // because it didn't fail
                    storedValue: 'ok',
                    rollbackCalled: false,
                }, next)
            ], done);
        });

        it('should rollback after error in persistent setter ' +
           'with persistent=false', function(done) {
            async.series([
                (next) => self.worker.setProperty({
                    id: 'test.rollbackTest',
                    value: 'fail persistent',
                    persistent: true
                }, (err) => {
                    expect(err).to.have.errorCode('EBADARG');
                    next();
                }),

                (next) => checkResult({
                    currentValue: 'ok',
                    storedValue: 'ok',
                    rollbackCalled: true,
                    rollbackErr: 'EBADARG: Failure in persistent setter',
                    origValue: 'ok',
                    newValue: 'fail persistent'
                }, next)
            ], done);
        });
    });
};
