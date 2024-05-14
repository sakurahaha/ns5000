var assert  = require('assert');
var Client  = require('nef/client');
var async   = require('async');
var interop = require('nef/interop');

describe('broker', function() {
    var client;
    var worker;

    before(function(done) {
        client = new Client('1.0', 'tcp://127.0.0.1:5557');
        assert.ok(client);
        // enable echo worker
        interop.call('procman', 'enableWorker', {name: 'echo'}, function(err) {
            if (err) {
                assert.equal(err.code, 'EEXIST');
            }

            // reset history of restarts to avoid delaying echo restart
            interop.call('procman', 'clearWorker', {name: 'echo'},
                    function(err) {
                assert.ifError(err);
                client.worker('echo', function(err, response) {
                    assert.ifError(err);
                    worker = response;
                    assert.ok(worker);
                    done();
                });
            });
        });
    });

    describe('.getWorkers()', function() {
        it('can retrieve list of registered workers', function(done) {
            client.getWorkers(function(err, msg) {
                assert.ifError(err);

                assert.ok(msg.indexOf('echo') !== -1);

                done();
            });
        });
    });

    describe('.WorkerAPI', function() {
        it('can retrieve worker name', function(done) {
            assert('name' in worker.desc);
            done();
        });
        it('can retrieve worker description', function(done) {
            assert('description' in worker.desc);
            done();
        });
        it('should error on calling not existing worker', function(done) {
            client.worker('notexists', function(err, msg) {
                assert.notEqual(err, 0);
                done();
            });
        });
        it('supports cross MDP worker calls', function(done) {
            worker.echoCrossAsync({str: 'msg1'}, function(err, msg) {
                assert.ifError(err);
                done();
            });
        });
    });
});
