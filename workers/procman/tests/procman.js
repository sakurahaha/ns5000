/*
 * Process manager BDD tests.
 *
 * TODO: Rewrite unit tests to avoid dependencies among them. Currently a unit
 * test depends on setup created by previous unit test. This is bad because it
 * doesn't allow running test independently from others and leads to chain of
 * failures if one of the tests fails.
 *
 * Copyright (C) 2012 Nexenta Systems, Inc
 * All rights reserved.
 */

'use strict';

const assert  = require('assert');
const async   = require('async');
const net     = require('net');
const fs      = require('fs');
const Client  = require('nef/client');
const events  = require('nef/events');
const interop = require('nef/interop');
const testHelpers = require('nef/testHelpers');
const nefUtils = require('nef/utils');
const procmanUtils = require('../procmanUtils');
const cp = require('child_process');

const config = nefUtils.requireConfig('config/common');
const defaultWorker = nefUtils.requireConfig('config/defaultWorker');

const PROCNAME = 'test-worker';

describe('Core tests', function() {

    testHelpers.initSuite(this, {
        tag: 'vm',
        requireWorkers: ['echo']
    });

    require('./broker'); // broker tests

    describe('Process manager', function() {
        var client;
        var worker;

        before('get raw client', function(done) {
            events.preconnect();
            client = new Client('1.0');
            client.worker('procman', function(err, msg) {
                assert.ifError(err);
                worker = msg;
                done();
            });
        });

        after(function(done) {
            client.disconnect();
            done();
        });

        describe('Core API', function() {
            it('can list workers', function(done) {
                worker.call('findWorkers', {}, function(err, msg) {
                    assert.ifError(err);
                    assert(msg);
                    assert(msg.length);
                    done();
                });
            });

            it('can list running workers with details', function(done) {
                worker.call('findWorkers', {
                    where: {
                        running: true
                    },
                    includeUsage: true,
                    includeStats: true
                }, function(err, msg) {
                    assert.ifError(err);
                    assert(msg);
                    assert(msg.length);
                    msg.forEach(function(wrk) {
                        assert.strictEqual(wrk.running, true);
                        assert(typeof wrk.pid, 'number');
                        assert.strictEqual(typeof wrk.cpu, 'number');
                        // The only exception are python workers.
                        // Python processes are 64-bit and thus mem usage is 0 for
                        // them.
                        if (!wrk.path.match(/\.py$/)) {
                            assert(wrk.memory > 0,
                                    'Memory footprint of running ' + wrk.name +
                                    ' worker is ' + wrk.memory);
                        }
                    });
                    done();
                });
            });

            it('can find worker by its name', function(done) {
                worker.call('findWorkers', {
                    where: {
                        name: 'echo'
                    }
                }, function(err, msg) {
                    assert.ifError(err);
                    assert.equal(msg.length, 1);
                    assert.equal(msg[0].name, 'echo');
                    done();
                });
            });
        });

        describe('Workers', function() {

            it('can disable echo worker', function(done) {
                testHelpers.waitWorkerStop('echo', (err) => {
                    assert.ifError(err);
                    interop.call('echo', 'echoSync', {str: 'foo'},
                            function(err, msg) {
                        assert.errorIs('ESRCH', err);
                        done();
                    });

                });
            });

            it('can enable echo worker', function(done) {
                testHelpers.waitWorkerStart('echo', (err) => {
                    assert.ifError(err);
                    interop.call('echo', 'echoSync', {str: 'bar'},
                            function(err, msg) {
                        assert.ifError(err);
                        assert.equal(msg, 'bar');
                        done();
                    });

                });
            });
        });

        describe('Respawning', function() {
            var respawnId = 0;
            testHelpers.skipKnown(this, 'NEF-13996');

            function waitRestartDelay(name, delay, done) {
                testHelpers.wait({
                    message: __('Wait for needed delay %s', delay),
                    interval: 500,
                    callback: function(next) {
                        worker.findWorkers({
                            where: {
                                name: name
                            }
                        }, function(err, res) {
                            next(undefined, res[0].respawnDelay >= delay);
                        });
                    }
                }, done);
            };

            before('register worker', function(done) {
                worker.call('registerWorker', {
                    name: PROCNAME,
                    path: 'true',
                    enabled: true
                }, done);
            });

            after('unregister worker', function(done) {
                worker.call('unregisterWorker', {
                    name: PROCNAME
                }, done);
            });

            it('should wait for delay up to 4s', function(done) {
                waitRestartDelay(PROCNAME, 4, done);
            });

            it('can clear respawn timeout', function(done) {
                async.series([
                    worker.clearWorker.bind(worker, {
                        name: PROCNAME
                    }),
                    function(next) {
                        worker.call('findWorkers', {
                            where: {
                                name: PROCNAME
                            },
                        }, function(err, msg) {
                            assert.ifError(err);
                            assert(msg[0].respawnDelay < 4);
                            next();
                        });
                    }
                ], done);
            });

            it('should wait for delay up to 4s', function(done) {
                waitRestartDelay(PROCNAME, 4, done);
            });

            it('can clear respawn timeout with restart method', function(done) {
                async.series([
                    worker.restartWorker.bind(worker, {
                        name: PROCNAME
                    }),
                    function(next) {
                        worker.call('findWorkers', {
                            where: {
                                name: PROCNAME
                            },
                        }, function(err, msg) {
                            assert.ifError(err);
                            assert(msg[0].respawnDelay < 4);
                            next();
                        });
                    }
                ], done);
            });
        });

        describe('Debugging', function() {

            function checkDebugPort(done) {
                var connected = false;
                var id = Math.random(100);
                var sock = net.connect(9229, function() {
                    connected = true;
                    sock.end();
                });
                sock.on('error', function() {
                    sock.destroy();
                });
                sock.on('close', function(hadError) {
                    done(undefined, connected);
                });
            }

            function waitDebug(name, isDebug, done) {
                testHelpers.wait({
                    interval: 500,
                    message: __('Wait debug for %s is %s', name, isDebug),
                    callback: function(next) {
                        worker.findWorkers({
                            where: {
                                name: name,
                                debug: isDebug,
                                online: true,
                            }
                        }, function(err, res) {
                            if (res.length !== 1) {
                                return next(undefined, false);
                            }

                            checkDebugPort(function(err, res) {
                                next(err, isDebug ? res : !res);
                            });
                        });
                    }
                }, done);
            };

            function resetDebugState(done) {
                async.series([
                    worker.disableDebug.bind(worker, {
                        name: 'echo'
                    }),
                    waitDebug.bind(this, 'echo', false),
                ], done);
            };

            before('enable worker', function(done) {
                testHelpers.waitWorkerStart('echo', function(err) {
                    if (err && err.code === 'EEXIST') {
                        done();
                    } else {
                        done(err);
                    }
                });
            });

            before('clear debug state', resetDebugState);
            after('clear debug state', resetDebugState);

            it('can enable debug on echo worker', function(done) {
                worker.call('enableDebug', {
                    name: 'echo'
                }, function(err, msg) {
                    assert.ifError(err);
                    waitDebug('echo', true, done);
                });
            });

            it('can restart worker under debug', function(done) {
                worker.call('restartWorker', {
                    name: 'echo'
                }, function(err, msg) {
                    assert.ifError(err);
                    waitDebug('echo', true, done);
                });
            });

            it('can disable debug on echo worker', function(done) {
                worker.call('disableDebug', {
                    name: 'echo'
                }, function(err, msg) {
                    assert.ifError(err);
                    waitDebug('echo', false, done);
                });
            });

            it('disabling debug on echo worker twice should be harmless',
                    function(done) {
                worker.call('disableDebug', {
                    name: 'echo'
                }, function(err, msg) {
                    assert.ifError(err);
                    waitDebug('echo', false, done);
                });
            });
        });

        describe('Heartbeat', function() {
            const restartTimeout = defaultWorker.livenessCounter * 3 * 1000;
            const killTimeout = 25000;
            const startupTimeout = 15000;
            var echoPid;

            function resetHeartbeat(done) {
                async.series([
                    worker.call.bind(worker, 'enableHeartbeat', {
                        name: 'echo'
                    }),
                    testHelpers.waitWorkerRestart.bind(this, 'echo'),
                ], done);
            }

            before('reset heartbeat', resetHeartbeat);
            after('reset heartbeat', resetHeartbeat);

            before('remember pid', function(done) {
                worker.findWorkers({
                    where: {
                        name: 'echo'
                    }
                }, function(err, res) {
                    assert.ifError(err);
                    assert.equal(res.length, 1);
                    echoPid = res[0].pid;
                    assert(echoPid);
                    done();
                });
            });

            it('can disable heartbeat check on echo worker', function(done) {
                worker.call('disableHeartbeat', {
                    name: 'echo'
                }, done);
            });

            it('should NOT restart worker if its suspended', function(done) {
                testHelpers.wait({
                    message: 'Check that procman doesn\'t restart echo',
                    timeout: restartTimeout,
                    timeoutIsOk: true,
                    callback: function(next) {
                        worker.findWorkers({
                            where: {
                                name: 'echo',
                                pid: echoPid,
                            }
                        }, function(err, res) {
                            next(err, res.length === 0);
                        });
                    },
                    prepare: function(next) {
                        process.kill(echoPid, 'SIGSTOP');
                        next();
                    }
                }, function(err) {
                    process.kill(echoPid, 'SIGCONT');
                    done(err);
                });
            });

            it('can enable heartbeat check', function(done) {
                worker.call('enableHeartbeat', {
                    name: 'echo'
                }, done);
            });

            it('should restart worker if its suspended', function(done) {
                testHelpers.wait({
                    message: 'Wait for procman to restart echo',
                    timeout: restartTimeout + startupTimeout + killTimeout,
                    callback: function(next) {
                        worker.findWorkers({
                            where: {
                                name: 'echo',
                                pid: echoPid,
                            }
                        }, function(err, res) {
                            next(err, res.length === 0);
                        });
                    },
                    prepare: function(next) {
                        process.kill(echoPid, 'SIGSTOP');
                        next();
                    }
                }, function(err) {
                    // Side effect of restarting worker which fails to send HB
                    // is that procman dumps core of it.
                    testHelpers.removeCore(echoPid, function(err2) {
                        done(err || err2);
                    });
                });
            });
        });
    });

    describe('memleakGuard', function() {
        before('set short guard interval', function(done) {
            interop.call('procman', 'rescheduleGuards', {
                interval: 2000
            }, done);
        });

        after('set default guard check interval', function(done) {
            interop.call('procman', 'rescheduleGuards', {}, done);
        });

        it('should kill echo when it take to much memory', function(done) {
            testHelpers.waitEvent({
                message: `Wait when procman kills echo`,
                event: 'NEF_procman_process_offline',
                filter: function(evt) {
                    return evt === 'echo';
                },
                prepare(next) {
                    interop.call('echo', 'eatMemory', {
                        amount: 25
                    }, next);
                }
            }, done);
        });
    });

    describe('procmanUtils', function() {

        describe('pid file managing', function() {
            var pidFile = '/tmp/nef-bdd-test.pid';

            function cleanup(done) {
                procmanUtils.removePidFileSync(pidFile);
                done();
            }

            before('cleanup', cleanup);
            after('cleanup', cleanup);

            it('should update pid file', function(done) {
                procmanUtils.updatePidFile(pidFile, done);
            });

            it('should not update pid file twice', function(done) {
                procmanUtils.updatePidFile(pidFile, (err) => {
                    assert.errorIs('EEXIST', err);
                });
                done();
            });

            it('should update pid file if we don\'t have processType',
                function(done) {

                    // Linux doesn't have this environment trick
                    if (process.platform === 'linux') {
                        this.skip();
                    }

                    procmanUtils.updatePidFile(pidFile, {
                        processType: 'test'
                    }, done);
                });

            it('should not update pid file with right processType',
                function(done) {
                    process.env.NEF_PROCESS_TYPE = 'test';
                    procmanUtils.updatePidFile(pidFile, {
                        processType: 'test'
                    }, (err) => {
                        assert.errorIs('EEXIST', err);
                        done();
                    });
                });

            it('should update pid file with wrong processType',
                function(done) {
                    // Linux doesn't have this environment trick
                    if (process.platform === 'linux') {
                        this.skip();
                    }

                    procmanUtils.updatePidFile(pidFile, {
                        processType: 'wrong-type'
                    }, done);
                });

            it('should kill old process if asked', function(done) {
                this.timeout(30000);

                var proc = cp.spawn('sleep', ['120']);

                proc.on('close', (code, signal) => {
                    done();
                });

                fs.writeFileSync(pidFile, proc.pid);

                procmanUtils.updatePidFile(pidFile, (err) => {
                    assert.errorIs('EEXIST', err);

                    procmanUtils.updatePidFile(pidFile, {
                        killCurrent: true
                    }, (err) => {
                        assert.ifError(err);
                    });
                });
            });
        });
    });
});
