var assert = require('assert');
var async = require('async');
var testHelpers = require('nef/testHelpers');
var nefUtils = require('nef/utils');
var interop = require('nef/interop');
var commonConfig = nefUtils.requireConfig('config/common');

module.exports = function test() {
    var self = this;

    describe('rebootNeeded property flag', function() {
        function cleanupRebootFlag(done) {
            self.worker.resetProperty({
                id: 'test.rebootTest',
                resetRebootNeeded: true
            }, done);
        };

        before(cleanupRebootFlag);
        after(cleanupRebootFlag);

        it('should not have rebootNeeded flag at the begining', function(done) {
            self.worker.findProperties({
                where: {id: 'test.rebootTest'},
            }, function(err, res) {
                assert.ifError(err);
                assert(!res[0].rebootNeeded);
                done();
            });
        });

        it('should update test property so rebootNeeded flag will be set',
                function(done) {
            self.worker.setProperty({
                id: 'test.rebootTest',
                value: 'reboot',
            }, function(err, res) {
                assert.ifError(err);
                assert.equal(res.rebootNeeded, true);
                done();
            })
        });

        it('should have rebootNeeded flag set after the updating',
                function(done) {
            self.worker.findProperties({
                where: {id: 'test.rebootTest'},
            }, function(err, res) {
                assert.ifError(err);
                assert(res[0].rebootNeeded);
                done();
            });
        });

        it('should emit event after updating property that needs reboot',
                function(done) {
            testHelpers.waitEvent({
                event: 'NEF_sysconfig_rebootNeeded',
                message: 'waiting for rebootNeeded event',
                prepare: function(next) {
                    self.worker.setProperty({
                        id: 'test.rebootTest',
                        value: 'reboot',
                    }, function(err, res) {
                        assert.ifError(err);
                        assert.equal(res.rebootNeeded, true);
                        next();
                    });
                },
                filter: function(event) {
                    return (nefUtils.isArray(event.ids) &&
                            event.ids.indexOf('test.rebootTest') > -1);
                },
                done: done,
            });
        });

        it('should get another rebootNeeded event after configured interval',
                function(done) {
            if (commonConfig.sysconfigEmitInterval > 5000) {
                this.skip('test');
            }

            testHelpers.waitEvent({
                event: 'NEF_sysconfig_rebootNeeded',
                message: 'waiting for another rebootNeeded event',
                prepare: function(next) {
                    next()
                },
                filter: function(event) {
                    return (nefUtils.isArray(event.ids) &&
                            event.ids.indexOf('test.rebootTest') > -1);
                },
                done: done,
            });
        });

        it('should restart sysconfig worker', function(done) {
            testHelpers.waitEvent({
                event: 'NEF_sysconfig_initialized',
                message: 'waiting for sysconfig',
                prepare: interop.call.bind(interop, 'procman', 'restartWorker',
                    {
                        name: 'sysconfig'
                    }),
                done: done,
            });
        });

        it('should still have rebootNeeded flag set after worker restart',
                function(done) {
            self.worker.findProperties({
                where: {id: 'test.rebootTest'},
            }, function(err, res) {
                assert.ifError(err);
                assert(res[0].rebootNeeded);
                done();
            });
        });
    });
};
