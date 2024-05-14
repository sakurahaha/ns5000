/*
 * Echo worker BDD tests.
 *
 * Copyright (C) 2012 Nexenta Systems, Inc
 * All rights reserved.
 *
 */

var assert = require('assert');
var async = require('async');
var Client = require('nef/client');
var events = require('nef/events');
var nefUtils = require('nef/utils');
var NefError = require('nef/error').NefError;
var aux = require('nef/testHelpers');
var dgram = require('dgram');
var equals = require('nef/utils').equals;
var config = nefUtils.requireConfig('testConfig/echo');
var exec = require('child_process').exec;

var snmpResetScript = './workers/echo/tests/prepare-snmp-daemon.sh';

describe('Echo', function() {
    var clientConnections = 3;
    var worker;
    var workers = [];
    var client;
    var clients = [];

    aux.initSuite(this, {
        tag: 'vm'
    });

    function initClientConnections(done) {
        // Making client connections and corresponding echo workers
        // for each one.
        var connectedCnt = 0;
        for (var i = 0; i < clientConnections; i++) {
            var cl = new Client('1.0', 'tcp://127.0.0.1:5557', {
                validateOutput: true
            });
            (function(cl) {
                cl.worker('echo', function(err, response) {
                    assert.ifError(err);
                    var wrk = response;
                    clients.push(cl);
                    workers.push(wrk);
                    /* When all clients are connected call done */
                    if (++connectedCnt == clientConnections) {
                        worker = workers[0];
                        client = clients[0];
                        done();
                    }
                });
            })(cl);
        }
    };

    before(function(done) {
        async.series([
            initClientConnections,
            function(next) {
                events.preconnect(next);
            }
        ], done);
    });

    after(function(done) {
        worker.call('coverageReport', {}, function(err, msg) {
            for (var i = 0; i < clientConnections; i++) {
                clients[i].disconnect();
            }
            if (err) {
                console.log('Failed to instrument: ' + err.toString());
                done();
                return;
            }
            console.log('\nCode coverage report saved at: ', msg);
            done();
        });
    });

    describe('echoSync()', function() {
        it('should return "blahblah"', function(done) {
            worker.call('echoSync', {str: 'blahblah'}, function(err, res) {
                assert.ifError(err);
                assert.equal('blahblah', res);
                done();
            });
        });

        it('should return "echoOk" from call()', function(done) {
            worker.call('echoSync', function(err, res) {
                assert.ifError(err);
                assert.equal('echoOk', res);
                done();
            });
        });

        it('should not return "wrong"', function(done) {
            worker.call('echoSync', {str: 'blahblah'}, function(err, res) {
                assert.ifError(err);
                assert.notEqual('wrong', res);
                done();
            });
        });

        it('should be able to use introspected call', function(done) {
            worker.echoSync({str: 'blahblah'}, function(err, res) {
                assert.ifError(err);
                assert.equal('blahblah', res);
                done();
            });
        });

        it('should not accept invalid argument type', function(done) {
            worker.echoSync({str: [333]}, function(err, res) {
                assert.equal(Client.errCode(err), 'EBADARG');
                done();
            });
        });
    });

    describe('Serialization tests', function() {
        it('should echo LocalString', function(done) {
            var s = __('Foo message: %s', new NefError('BARCODE',
                    __('Nested subdescription: %s', 'bar')));
            worker.call('echoSync', {str: s.toString()}, function(err, res) {
                assert.ifError(err);
                assert.equal(res.toString(),
                        'Foo message: BARCODE: Nested subdescription: bar');
                done();
            });
        });
        it('should echo NefError', function(done) {
            var s = NefError('FOO', __('Foo error: %s', NefError('BARCODE',
                    __('Nested subdescription: %s', 'bar'))));
            worker.call('echoSync', {str: s.toString()}, function(err, res) {
                assert.ifError(err);
                assert.equal(res.toString(),
                        'FOO: Foo error: BARCODE: Nested subdescription: bar');
                done();
            });
        });
    });

    describe('echoAsync()', function() {
        it('should return "hello, world" after 500ms delay', function(done) {
            worker.call('echoAsync', {str: 'hello, world'},
                    function(err, res) {
                assert.ifError(err);
                assert.equal('hello, world', res);
                done();
            });
        });

        it('should not accept zero arguments', function(done) {
            worker.echoAsync({}, function(err, res) {
                assert.equal(Client.errCode(err), 'EBADARG');
                done();
            });
        });

        it('should be able to use direct call', function(done) {
            worker.echoAsync({str: 'hello, world'}, function(err, res) {
                assert.ifError(err);
                assert.equal('hello, world', res);
                done();
            });
        });
    });

    describe('echoCrossAsync()', function() {
        it('should return "hello, world" after cross async call',
                function(done) {
            worker.echoCrossAsync({str: 'hello, world'}, function(err, res) {
                assert.ifError(err);
                assert.equal('hello, world', res);
                done();
            });
        });
    });

    // disabling this until fixed
    describe('echoAsyncNative()', function() {
        it('should return "hello, world" after 500ms delay using ' +
                'async binding call',
                function(done) {
            worker.call('echoAsyncNative', {str: 'hello, world'},
                    function(res, msg) {
                assert.equal('hello, world', msg);
                done();
            });
        });

        it('should return "hello, world" after 500ms delay using ' +
                'sync binding call',
                function(done) {
            worker.call('echoSyncNative', {str: 'hello, world'},
                    function(res, msg) {
                assert.equal('hello, world', msg);
                done();
            });
        });

        it('should be able to use direct call', function(done) {
            worker.echoAsyncNative({str: 'hello, world'}, function(res, msg) {
                assert.equal('hello, world', msg);
                done();
            });
        });
    });

    describe('Events', function() {
        it('should emit "foo" event', function(done) {
            events.private.on('NEF_echo_echo', function(args, event) {
                assert.equal(event.name, 'NEF_echo_echo');
                assert.equal(args.str, 'foo');
                done();
            });
            /* Timer to work around slow subscriber problem (see zmq manual) */
            setTimeout(function() {
                worker.call('echoEvent', {
                    str: 'foo'
                }, function(err, res) {
                    assert.ifError(err);
                });
            }, 500);
        });
    });

    describe('workerErrors()', function() {
        it('should return error when accessing nonexistent worker',
            function(done) {
            worker.call('IDONOTEXIST', {}, function(err, msg) {
                assert.equal(Client.errCode(err), 'EBADARG');
                done();
            });
        });

        it('should fail if output is misformed', function(done) {
            /*
             * Depending on whether validation of API output is turned on
             * or off, this will fail with different errors. If validation is
             * turned off then client will generate EINVAL error. If validation
             * is turned on then server will generate EFAILED error.
             */
            worker.returnInvalidOutput({}, function(err, msg) {
                assert(Client.errCode(err) === 'EINVAL' ||
                        Client.errCode(err) === 'EFAILED');
                done();
            });
        });

        it('should fail if output is missing', function(done) {
            /*
             * Depending on whether validation of API output is turned on
             * or off, this will fail with different errors. If validation is
             * turned off then client will generate EINVAL error. If validation
             * is turned on then server will generate EFAILED error.
             */
            worker.returnInvalidOutput({returnSomething: false},
                    function(err, msg) {
                assert(Client.errCode(err) === 'EINVAL' ||
                        Client.errCode(err) === 'EFAILED');
                done();
            });
        });
    });

    describe('echoBenchmarkSync()', function() {
        it('should do at least 100 calls per second', function(done) {
            var calls = 0;
            var arr = [];
            for (var i = 0; i < 100; i++) {
                arr[i] = i;
            }
            var start = new Date().getTime();
            async.forEach(arr, function(i, cb) {
                worker.call('echoBenchmarkSync', {str: 'blahblah'},
                    function(err, res) {
                        assert.ifError(err);
                        calls++;
                        cb();
                    });
            }, function(err) {
                var end = new Date().getTime();
                assert.equal(calls, 100);
                assert(end - start < 1000, 'Too long time: ' + (end - start));
                done();
            });
        });
    });

    /*
     * Sequence test. Given an expected response order it ensures
     * callbacks were called in proper order.
     */
    var SequenceTest = function(expectedCnt, expectedData, done) {
        this.expectedCnt = expectedCnt;
        this.expectedData = expectedData;
        this.respCnt = 0;
        this.respData = '';
        this.done = done;
        this.startedAt = (new Date()).getTime();
    };

    SequenceTest.prototype.sendRequest =
                                function(worker, methodName, methodArgs) {
        var self = this;
        worker.call(methodName, methodArgs, function(err, res) {
            assert.ifError(err);
            self.respData += res;
            self.respCnt++;
            if (self.respCnt == self.expectedCnt) {
                assert.equal(self.expectedData, self.respData);
                var now = (new Date()).getTime();
                self.elapsed = now - self.startedAt;
                self.done();
            }
        });
    };

    describe('synchronization tests', function() {
        it('short call should return in less than 400 ms', function(done) {
            var test = new SequenceTest(1, 'foo', function() {
                assert.ok(test.elapsed < 400);
                done();
            });
            test.sendRequest(workers[0], 'echoAsync', {str: 'foo', delay: 50});
        });

        it('long call should return in more than 400 ms', function(done) {
            var test = new SequenceTest(1, 'bar', function() {
                assert.ok(test.elapsed > 400);
                done();
            });
            test.sendRequest(workers[0], 'echoAsync', {str: 'bar', delay: 500});
        });

        /* In this test single client tries to make 3 request: 'foo', 'bar'
         * and 'baz'. Since ZeroMQ serializes requests from the single client
         * internally, responses should arrive in the same order as requested:
         * 'foo', then 'bar', and finally 'baz'.
         */
        it('nonlocking, single client', function(done) {
            var test = new SequenceTest(3, 'foobarbaz', done);
            test.sendRequest(workers[0], 'echoAsync', {str: 'foo', delay: 500});
            test.sendRequest(workers[0], 'echoAsync', {str: 'bar', delay: 250});
            test.sendRequest(workers[0], 'echoAsync', {str: 'baz', delay: 50});
        });

        /* In this test 3 clients try to make 'foo', 'bar' and 'baz' requests
         * with small interval (50 ms). Since there is no locking in echoAsync
         * method, requests should be processed simultaneously and return
         * immediately after given interval of time. So the shortest request
         * 'baz' will return first, then 'bar' and 'foo' will be the last
         */
        it('nonlocking, multiple clients', function(done) {
            var test = new SequenceTest(3, 'bazbarfoo', done);
            test.sendRequest(workers[0], 'echoAsync',
                    {str: 'foo', delay: 500});
            setTimeout(function() {
                test.sendRequest(workers[1], 'echoAsync',
                        {str: 'bar', delay: 250});
                setTimeout(function() {
                    test.sendRequest(workers[2], 'echoAsync',
                            {str: 'baz', delay: 50});
                }, 50);
            }, 50);
        });

        /* In this test 3 clients try to make the same requests in the same
         * order but with locking. The first 'foo' request will be received
         * and processed first. The following requests will be queued and
         * processed in sequental order. So response should be 'foo', 'bar',
         * 'baz'.
         */
        it('locking, multiple clients', function(done) {
            var test = new SequenceTest(3, 'foobarbaz', done);
            test.sendRequest(workers[0], 'echoLocking',
                    {str: 'foo', delay: 500});
            setTimeout(function() {
                test.sendRequest(workers[1], 'echoLocking',
                        {str: 'bar', delay: 250});
                setTimeout(function() {
                    test.sendRequest(workers[2], 'echoLocking',
                            {str: 'baz', delay: 50});
                }, 100);
            }, 100);
        });

        /* Several locking tests. A, B and AB suffixes mean list of keys
         * being locked by this method
         *  */
        it('A, B must be executed simultaneously', function(done) {
            var test = new SequenceTest(2, 'barfoo', done);
            test.sendRequest(workers[0], 'echoLockingA',
                    {str: 'foo', delay: 500});
            setTimeout(function() {
                test.sendRequest(workers[1], 'echoLockingB',
                        {str: 'bar', delay: 250});
            }, 100);
        });

        it('A, AB must be executed in order A => AB', function(done) {
            var test = new SequenceTest(2, 'foobar', done);
            test.sendRequest(workers[0], 'echoLockingA',
                    {str: 'foo', delay: 500});
            setTimeout(function() {
                test.sendRequest(workers[1], 'echoLockingAB',
                        {str: 'bar', delay: 50});
            }, 100);
        });

        it('AB, A must be executed in order AB => A', function(done) {
            var test = new SequenceTest(2, 'foobar', done);
            test.sendRequest(workers[0], 'echoLockingAB',
                    {str: 'foo', delay: 500});
            setTimeout(function() {
                test.sendRequest(workers[1], 'echoLockingA',
                        {str: 'bar', delay: 50});
            }, 100);
        });

        /* The following test needs some comment. A is started first and
         * immediately locks 'A' key. After that AB is started and its
         * execution is delayed due to waiting 'A' lock. Then B starts. Key
         * 'B' is not locked, and B is executed immediately. It's very short
         * (0ms), so it returns first. Then AB is finished, and finally B is
         * executed
         * */
        it('A, AB, B must be executed in order A => B => AB',
                function(done) {
            var test = new SequenceTest(3, 'bazfoobar', done);
            test.sendRequest(workers[0], 'echoLockingA',
                    {str: 'foo', delay: 500});
            setTimeout(function() {
                test.sendRequest(workers[1], 'echoLockingAB',
                        {str: 'bar', delay: 50});
                setTimeout(function() {
                    test.sendRequest(workers[2], 'echoLockingB',
                            {str: 'baz', delay: 50});
                }, 100);
            }, 100);
        });
    });

    describe('explicit locking tests', function() {
        it('A, B must be executed simultaneously', function(done) {
            var test = new SequenceTest(2, 'barfoo', done);
            test.sendRequest(workers[0], 'echoExplicitLocking',
                    {locks: ['A'], str: 'foo', delay: 500});
            setTimeout(function() {
                test.sendRequest(workers[1], 'echoExplicitLocking',
                        {locks: ['B'], str: 'bar', delay: 250});
            }, 100);
        });

        it('A, AB must be executed in order A => AB', function(done) {
            var test = new SequenceTest(2, 'foobar', done);
            test.sendRequest(workers[0], 'echoExplicitLocking',
                    {locks: ['A'], str: 'foo', delay: 500});
            setTimeout(function() {
                test.sendRequest(workers[1], 'echoExplicitLocking',
                        {locks: ['A', 'B'], str: 'bar', delay: 50});
            }, 100);
        });
    });

    describe('echoAsyncWithNotifications()', function() {
        it('progress notifications should be delivered on time',
                function(done) {
            aux.skipKnown(this, 'NEX-20248');
            worker.echoAsyncWithNotifications({str: 'foo', delay: 3000},
                    function(err, msg) {
                assert.ifError(err);
                assert.equal(msg.length, 6, 'Should return 6 entries');
                for (var i = 0; i <= 4; i++) {
                    var avg = i * 750;
                    var min = avg - 300;
                    var max = avg + 300;
                    var actual = msg[i].timeOffset;
                    assert.ok(actual >= min, 'Notification #' + i +
                            ' should arrive not earlier than ' + min +
                            'ms (avg ' + avg + 'ms). Actual data: ' +
                            JSON.stringify(msg));
                    assert.ok(actual <= max, 'Notification #' + i +
                            ' should arrive not later than ' + max +
                            'ms (avg ' + avg + 'ms). Actual data: ' +
                            JSON.stringify(msg));
                }
                assert.equal(msg[0].str, 'foo-0%');
                assert.equal(msg[1].str, 'foo-25%');
                assert.equal(msg[2].str, 'foo-50%');
                assert.equal(msg[3].str, 'foo-75%');
                assert.equal(msg[4].str, 'foo-100%');
                assert.equal(msg[5].str, 'foo');
                done();
            });
        });
    });

    describe('Request timeouts', function() {
        it('subsequent requests should be serialized', function(done) {
            var test = new SequenceTest(2, 'foobar', function() {
                assert.ok(test.elapsed > 300);
                done();
            });
            test.sendRequest(workers[0], 'echoAsync', {str: 'foo', delay: 200});
            test.sendRequest(workers[0], 'echoAsync', {str: 'bar', delay: 200});
        });

        it('request should be completed on time', function(done) {
            worker.echoAsync({str: 'foo', delay: 500, timeout: 2000},
                    function(err, msg) {
                assert.ifError(err);
                assert.equal(msg, 'foo');
                done();
            });
        });
        it('request should be interrupted on timeout', function(done) {
            worker.echoAsync({str: 'bar', delay: 2000, timeout: 500},
                    function(err, msg) {
                assert.equal(Client.errCode(err), 'ETIMEDOUT');
                done();
            });
        });
        it('request should not receive outdated data', function(done) {
            worker.echoAsync({str: 'baz', delay: 2000}, function(err, msg) {
                assert.ifError(err);
                assert.equal(msg, 'baz');
                done();
            });
        });
        it('request with overriden timeout should complete on time',
                function(done) {
            worker.echoAsync({str: 'BAZ', delay: 1000, timeout: 2000},
                    function(err, msg) {
                assert.ifError(err);
                assert.equal(msg, 'BAZ');
                done();
            });
        });
    });
});
