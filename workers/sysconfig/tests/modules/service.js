/**
 * @FileOverview Tests for testing service API in a very basic way
 * using test service.
 */

var async  = require('async');
var chai   = require('chai');
var assert = chai.assert;
var expect = chai.expect;

module.exports = function() {
    var self = this;

    function setDefaults(done) {
        // no reason to set rebootTest, it always behaves as undefined
        self.worker.bulkSetProperties({
            persistent: true,
            pairs: {
                'test.aValue': null,
                'test.anObject': {}
            }
        }, done);
    }

    /*
     * Skip all tests if test service is not enabled.
     * Set service properties to known state.
     */
    before(function(done) {
        var ts = this;

        self.worker.findServices({
            where: {name: 'test'}
        }, function(err, res) {
            if (err) {
                done(err);
                return;
            }
            if (res.length === 0) {
                ts.skip('Test service not enabled');
                // not reached
            }
            setDefaults(done);
        });
    });

    after(function(done) {
        setDefaults(done);
    });

    it('should find service', function(done) {

        self.worker.findServices({
            where: {name: 'test'}
        }, function(err, res) {
            if (err) {
                done(err);
                return;
            }
            expect(res).to.have.length(1);
            expect(res[0]).to.have.property('name', 'test');
            expect(res[0].description).to.be.a('string');
            expect(res[0]).to.have.property('state', 'online');
            done();
        });
    });

    it('should get service properties', function(done) {

        self.worker.getServiceProperties({
            name: 'test'
        }, function(err, res) {
            if (err) {
                done(err);
                return;
            }
            // rebootTest is always undefined
            expect(res).to.have.keys('scalar', 'obj');
            done();
        });
    });

    it('should get service properties with meta-data', function(done) {

        self.worker.getServiceProperties({
            name: 'test',
            metaInfo: true
        }, function(err, res) {
            if (err) {
                done(err);
                return;
            }
            expect(res).to.have.property('metaInfo');
            expect(res.metaInfo).to.have.keys('scalar', 'obj', 'rebootTest');
            done();
        });
    });

    it('should set and reset service properties', function(done) {

        async.waterfall([
            function(next) {
                self.worker.setServiceProperties({
                    name: 'test',
                    properties: {
                        scalar: 100,
                        obj: {a: 2, b: 'hello'}
                    }
                }, next);
            },
            function(res, next) {
                self.worker.getServiceProperties({
                    name: 'test'
                }, next);
            },
            function(res, next) {
                expect(res).to.have.property('scalar', 100);
                expect(res).to.have.property('obj');
                expect(res.obj).to.deep.equal({a: 2, b: 'hello'});

                // test reset
                self.worker.setServiceProperties({
                    name: 'test',
                    properties: {
                        scalar: null
                    }
                }, next);
            },
            function(res, next) {
                self.worker.getServiceProperties({
                    name: 'test'
                }, next);
            },
            function(res, next) {
                expect(res).to.have.property('scalar');
                expect(res.scalar).to.not.equal(100);
                next();
            }
        ], done);
    });

    it('should not restart service if restart is not implemented',
            function(done) {

                self.worker.restartService({name: 'test'}, function(err) {
            expect(err).to.be.errorCode('ENOSYS');
            done();
        });
            });

    it('should not refresh service if refresh is not implemented',
            function(done) {

                self.worker.refreshService({name: 'test'}, function(err) {
            expect(err).to.be.errorCode('ENOSYS');
            done();
        });
            });

    it('should not clear service if clear is not implemented',
            function(done) {

                self.worker.clearService({name: 'test'}, function(err) {
            expect(err).to.be.errorCode('ENOSYS');
            done();
        });
            });

    it('should not enable service if enable is not implemented',
            function(done) {

                self.worker.enableService({name: 'test'}, function(err) {
            expect(err).to.be.errorCode('ENOSYS');
            done();
        });
            });

    it('should not disable service if disable is not implemented',
            function(done) {

                self.worker.disableService({name: 'test'}, function(err) {
            expect(err).to.be.errorCode('ENOSYS');
            done();
        });
            });
};
