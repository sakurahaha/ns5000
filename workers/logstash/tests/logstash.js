/*
 * Logstash worker BDD tests.
 *
 * Copyright (C) 2014 Nexenta Systems, Inc
 * All rights reserved.
 *
 */

var assert = require('assert');
var Client = require('nef/client');
var async = require('async');
var interop = require('nef/interop');
var nefUtils = require('nef/utils');
var testHelpers = require('nef/testHelpers');
var compoundUtils = require('nef/compoundUtils');
var nef = require('nef');
var exec = require('child_process').exec;

var knownSeverities = [
    'emergency',
    'alert',
    'critical',
    'error',
    'warning',
    'notice',
    'info',
    'debug'
];

var worker;
var cachedHostname;

function getSeverityLevel(check, done) {
    interop.call('sysconfig', 'findProperties', {
        where: {
            idIn: ['worker.logstash.logSeverity'],
        },
        includeCurrentValues: true,
    }, function(err, res) {
        assert.ifError(err);

        var dict = nefUtils.arrayToDict(res, 'id', 'currentValue');
        assert(knownSeverities.indexOf(dict['worker.logstash.logSeverity']) >=
            0);
        done(err, dict['worker.logstash.logSeverity']);
    });
}

function setSeverityLevel(level, check, done) {
    interop.call('sysconfig', 'setProperty', {
        id: 'worker.logstash.logSeverity',
        value: level
    }, function(err) {
        if (check) {
            assert.ifError(err);

            /* Make sure the level has been changed. */
            getSeverityLevel(true, function(err, res) {
                assert(res === level);
                done();
            });
        } else {
            done(err);
        }
    });
}

function validateLogRecord(rec) {
    assert(rec.component, 'Component is missing in log record');
    assert(rec.message, 'Message is missing in log record');
    assert(rec.facility, 'Facility is missing in log record');
    assert(rec.severity, 'Severity is missing in log record');
    assert(rec.timestamp, 'Timestamp is missing in log record');
    assert(rec.hostId, 'hostId is missing in log record');
    assert.strictEqual(rec.origin, 'atomic',
        'Invalid origin in log record');
    assert.strictEqual(rec.hostname, undefined, 'Old hostname still exists');
    if (rec.hostName !== '[localhost]') {
        assert.strictEqual(rec.hostName, cachedHostname, 'Hostname mismatches');
    }

    assert.strictEqual(rec.component.indexOf('['), -1,
        'Component still contains PID');
};

describe('logstash.', function() {
    var severityLevel;
    var self = this;
    var indexName;

    testHelpers.initSuite(this, {
        tag: 'vm'
    });

    before(function(done) {
        async.series([
            (next) => {
                client = new Client('1.0', 'tcp://127.0.0.1:5557', {
                    validateOutput: true
                });
                client.worker('logstash', function(err, val) {
                    assert.ifError(err);
                    worker = val;
                    next();
                });
            },
            // Cache hostname.
            (next) => {
                nef.getHostname(function(err, res) {
                    cachedHostname = res;
                    next(err);
                });
            }
        ], done);
    });

    describe('Logstash worker API', function() {
        it('should be able to get current severity filter level',
            function(done) {
                getSeverityLevel(true, function(err, level) {
                    done();
                });
            });

        it('should be able to set all known severity levels', function(done) {
            async.forEachSeries(knownSeverities, function(severity, next) {
                setSeverityLevel(severity, true, function() {
                    next();
                });
            }, function(err) {
                done();
            });
        });

        it('should not be able to apply bad severity level', function(done) {
            async.series([
                /* Get current severity level. */
                function(next) {
                    severityLevel = null;

                    getSeverityLevel(true, function(err, level) {
                        severityLevel = level;
                        next();
                    });
                },
                /* Try to apply improper severity level. */
                function(next) {
                    setSeverityLevel('unknownSeverity', false, function(err) {
                        assert(err);
                        assert.equal(err.code, 'EBADARG');
                        next();
                    });
                },
                /* Make sure current severity level hasn't changed. */
                function(next) {
                    getSeverityLevel(true, function(err, level) {
                        assert(severityLevel === level);
                        next();
                    });
                }
            ], function(err) {
                done();
            });
        });
    });

    describe('Logstash Fusion connectivity', function() {
        var compoundNode;
        var esdbServer;
        var apiAccessCount = 0;
        var numEventsReceived = 0;

        testHelpers.skipKnown(this, 'NEX-20704');

        before(function(done) {
            async.series([
                function(next) {
                    setBlacklist([], next);
                },
                function(next) {
                    compoundNode = new testHelpers.CompoundNode({
                        api: {
                            handlers: {
                                '/privateApi': function(body) {
                                    if (body.type === 'log' &&
                                        nefUtils.isArray(body.body)) {

                                        // Make sure all log records are
                                        // well-formed.
                                        for (let l of body.body) {
                                            validateLogRecord(l);
                                            numEventsReceived++;
                                        }

                                        apiAccessCount++;
                                    }
                                }
                            }
                        }
                    });
                    compoundNode.start(next);
                },
                function(next) {
                    compoundNode.bind(next);
                },
                function(next) {
                    esdbServer = compoundNode.getEsdbServer();
                    indexName = compoundUtils.getEventIndex('logs');
                    next();
                }
            ], done);
        });

        after(function(done) {
            esdbServer.lockDatabase(false);

            async.series([
                function(next) {
                    compoundNode.stop(next);
                },
                function(next) {
                    compoundNode.unbind(next);
                }
            ], done);
        });

        function setBlacklist(blacklist, done) {
            interop.call('sysconfig', 'setProperty', {
                'id': 'worker.logstash.messageBlacklist',
                'value': blacklist
            }, done);
        };

        it('should receive test message with its severity', function(done) {
            var msgPattern = 'unable to determine name for GID';
            var testMessage = msgPattern + ': 10132';
            var logMsg = 'Dec 10 05:25:15 ' + cachedHostname +
                ' nfsd[200548]: [ID 802721 daemon.error]  ' + testMessage;
            var indexName = compoundUtils.getEventIndex('logs');

            async.series([
                // Reset blacklist to allow all messages flow.
                function(next) {
                    setBlacklist([], next);
                },
                // Inject test message.
                function(next) {
                    apiAccessCount = 0;

                    esdbServer.clear();

                    worker.injectLogMessage({
                        message: logMsg
                    }, next);
                },
                // Wait for message to arrive.
                function(next) {
                    testHelpers.wait({
                        timeout: 30000, // Log record must arrive within 30 secs.
                        msg: 'Waiting for test log message to arrive',
                        callback: function(cb) {
                            var logs = esdbServer.search({
                                index: indexName,
                                type: '_doc'
                            }).filter((msg) => {
                                return msg.message === testMessage;
                            });

                            for (var r of logs) {
                                validateLogRecord(r);
                            }

                            cb(undefined, logs.length > 0);
                        }
                    }, next);
                }
            ], done);
        });

        it('component PID should be removed', function(done) {
            var msgPattern = 'unable to determine name for GID';
            var testMessage = msgPattern + ': 77732';
            var component = 'nfsd';
            var logMsg = 'Dec 10 05:25:15 ' + cachedHostname + ' ' +
                component + '[123495]: [ID 802721 daemon.error]  ' +
                testMessage;
            var indexName = compoundUtils.getEventIndex('logs');
            var logRecord;

            async.series([
                // Reset blacklist to allow all messages flow.
                function(next) {
                    setBlacklist([], next);
                },
                // Inject test message.
                function(next) {
                    apiAccessCount = 0;

                    esdbServer.clear();

                    worker.injectLogMessage({
                        message: logMsg
                    }, next);
                },
                // Wait for message to arrive.
                function(next) {
                    testHelpers.wait({
                        timeout: 30000, // Log record must arrive within 30 secs.
                        msg: 'Waiting for test log message to arrive',
                        callback: function(cb) {
                            var logs = esdbServer.search({
                                index: indexName,
                                type: '_doc'
                            }).filter((msg) => {
                                return msg.message === testMessage;
                            });

                            if (logs.length === 1) {
                                logRecord = logs[0];
                            }
                            cb(undefined, logs.length === 1);
                        }
                    }, () => {
                        assert(logRecord, 'No log record arrived');
                        assert.strictEqual(logRecord.component, component);
                        next();
                    });
                }
            ], done);
        });

        it('node should send logs depending on Fusion ES index',
        function(done) {
            var msgPattern = 'unable to determine name for GUID';
            var testMessage = msgPattern + ':718131';
            var logMsg = 'Dec 10 05:25:15 ' + cachedHostname +
                ' syslog[620548]: [ID 981721 daemon.error]  ' + testMessage;
            var indexName = compoundUtils.getEventIndex('logs');

            this.timeout(120000);

            esdbServer.clear();

            async.series([
                // Inject test message.
                function(next) {
                    worker.injectLogMessage({
                        message: logMsg
                    }, next);
                },
                // Wait for test log message to arrive.
                function(next) {
                    testHelpers.wait({
                        timeout: 30000, // Log record must arrive within 30 secs.
                        msg: 'Waiting for test log message to arrive',
                        callback: function(cb) {
                            var logs = esdbServer.search({
                                index: indexName,
                                type: '_doc'
                            }).filter((msg) => {
                                return msg.message === testMessage;
                            });

                            cb(undefined, logs.length > 0);
                        }
                    }, next);
                },
                function(next) {
                    // Since this moment we shouldn't see any events.
                    esdbServer.lockDatabase(true);
                    esdbServer.clear();

                    apiAccessCount = 0;

                    worker.injectLogMessage({
                        message: logMsg
                    }, next);
                },
                (next) => {
                    testHelpers.wait({
                        timeout: 30000,
                        timeoutIsOk: true,
                        message: 'Check that there are no logs for 30 sec',
                        callback: function(cb) {
                            var logs = esdbServer.search({
                                index: indexName,
                                type: '_doc'
                            }).filter((msg) => {
                                return msg.message === testMessage;
                            });

                            assert.strictEqual(logs.length, 0,
                                'Log message arrived in disabled ESDB');
                            assert.strictEqual(apiAccessCount, 0,
                                'API was accessed while ESDB is disabled');
                            cb(undefined, false);
                        }
                    }, next);
                },
                function(next) {
                    // Make sure no API was accessed.
                    assert.strictEqual(apiAccessCount, 0,
                        'API was accessed while ESDB is locked');

                    // Unlock database and wait for the log message.
                    esdbServer.lockDatabase(false);

                    testHelpers.wait({
                        timeout: 30000,
                        message: 'Check that log arrives in enabled ESDB',
                        callback: function(cb) {
                            var logs = esdbServer.search({
                                index: indexName,
                                type: '_doc'
                            }).filter((msg) => {
                                return msg.message === testMessage;
                            });

                            cb(undefined, logs.length > 0);
                        }
                    }, next);
                },
                (next) => {
                    // Make sure API was accessed.
                    assert(apiAccessCount > 0,
                        'API was not accessed while posting log to ESDB');
                    next();
                }
            ], done);
        });

        it('should receive non-standard log message', function(done) {
            if (process.platform == 'linux') {
                // Doesn't work on linux - no syseventd daemon
                this.skip();
            }

            async.waterfall([
                // Reduce severity level to INFO.
                (next) => {
                    setSeverityLevel('info', true, next);
                },
                // Locate 'syseventd', it's gonna be used for triggering
                // the following log message upon SIGHUP:
                // Feb 18 23: 20: 31 521a syseventd[100135]: Daemon restarted
                (next) => {
                    var cmd = 'ps ax | grep "sysevent/syseventd" | ' +
                        'grep -v grep | awk \'{print $1}\'';
                    exec(cmd, (error, stdout, stderr) => {
                        if (error) {
                            return next(error);
                        }

                        next(undefined, stdout.toString().trim());
                    });
                },
                // Restart the daemon.
                (pid, next) => {
                    esdbServer.clear();

                    exec('kill -1 ' + pid, (error, stdout, stderr) => {
                        if (error) {
                            return next(error);
                        }
                        next();
                    });
                },
                // Wait for message to arrive.
                function(next) {
                    testHelpers.wait({
                        timeout: 30000, // Log record must arrive within 30 secs.
                        msg: 'Waiting for test log message to arrive',
                        callback: function(cb) {
                            var logs = esdbServer.search({
                                index: indexName,
                                type: '_doc'
                            }).filter((msg) => {
                                return msg.component === 'syseventd' &&
                                    msg.message.indexOf(
                                        'Daemon restarted') > 0;
                            });

                            cb(undefined, logs.length > 0);
                        }
                    }, next);
                }
            ], done);
        });

        it('should receive non-standard message without PID', function(done) {
            var logMsg = 'Jan 29 04:12:38 ' + cachedHostname + ' scsi: ' +
                'WARNING: ata1: timeout: reset bus, target=0 lun=0';

            async.series([
                (next) => {
                    setSeverityLevel('info', true, next);
                },
                // Reset blacklist to allow all messages flow.
                function(next) {
                    setBlacklist([], next);
                },
                // Inject test message.
                function(next) {
                    apiAccessCount = 0;

                    esdbServer.clear();

                    worker.injectLogMessage({
                        message: logMsg
                    }, next);
                },
                // Wait for message to arrive.
                function(next) {
                    testHelpers.wait({
                        timeout: 30000, // Log record must arrive within 30 secs.
                        msg: 'Waiting for test log message to arrive',
                        callback: function(cb) {
                            var logs = esdbServer.search({
                                index: indexName,
                                type: '_doc'
                            }).filter((msg) => {
                                return msg.component === 'unknown' &&
                                    msg.severity === 'info' &&
                                    msg.facility === 'daemon' &&
                                    msg.message.indexOf(
                                        'scsi: WARNING: ata1: timeout:') === 0;
                            });

                            cb(undefined, logs.length > 0);
                        }
                    }, next);
                },
                (next) => {
                    // Make sure API was accessed.
                    assert(apiAccessCount > 0,
                        'API was not accessed while posting log to ESDB');
                    next();
                }
            ], done);
        });

        it('should receive non-standard KRRP message', function(done) {
            var logMsg = 'Jan 29 07:51:52 ' + cachedHostname + ' krrp: ' +
                         'NOTICE: PDU Engine config: dblk_head_sz:[0], ' +
                         'dblk_data_sz:[2048], max_mem:[100 MB], ' +
                         'dblks_per_pdu:[1], prealloc:[NO]';

            async.series([
                (next) => {
                    setSeverityLevel('info', true, next);
                },
                // Reset blacklist to allow all messages flow.
                function(next) {
                    setBlacklist([], next);
                },
                // Inject test message.
                function(next) {
                    apiAccessCount = 0;

                    esdbServer.clear();

                    worker.injectLogMessage({
                        message: logMsg
                    }, next);
                },
                // Wait for message to arrive.
                function(next) {
                    testHelpers.wait({
                        timeout: 30000, // Log record must arrive within 30 secs.
                        msg: 'Waiting for test log message to arrive',
                        callback: function(cb) {
                            var logs = esdbServer.search({
                                index: indexName,
                                type: '_doc'
                            }).filter((msg) => {
                                return msg.component === 'unknown' &&
                                    msg.severity === 'info' &&
                                    msg.facility === 'daemon' &&
                                    msg.message.indexOf(
                                        'krrp: NOTICE: PDU Engine') === 0;
                            });

                            cb(undefined, logs.length > 0);
                        }
                    }, next);
                },
                (next) => {
                    // Make sure API was accessed.
                    assert(apiAccessCount > 0,
                        'API was not accessed while posting log to ESDB');
                    next();
                }
            ], done);
        });

        it('should apply message blacklist', function(done) {
            var msgPattern = 'unable to determine name for UID';
            var testMessage = msgPattern + ': 10131';
            var logMsg = 'Dec 10 05:25:15 ' + cachedHostname +
                ' smbd[100548]: [ID 801721 daemon.error]  ' + testMessage;
            var indexName = compoundUtils.getEventIndex('logs');

            async.series([
                // Reset blacklist to allow all messages flow.
                function(next) {
                    setBlacklist([], next);
                },
                // Inject test message.
                function(next) {
                    apiAccessCount = 0;

                    worker.injectLogMessage({
                        message: logMsg
                    }, next);
                },
                // Wait for message to arrive.
                function(next) {
                    testHelpers.wait({
                        timeout: 30000, // Log record must arrive within 30 secs.
                        msg: 'Waiting for test log message to arrive',
                        callback: function(cb) {
                            var logs = esdbServer.search({
                                index: indexName,
                                type: '_doc'
                            }).filter((msg) => {
                                return msg.message === testMessage;
                            });

                            cb(undefined, logs.length > 0);
                        }
                    }, next);
                },
                // Apply blacklist filter and make sure no messages arrive.
                function(next) {
                    assert(apiAccessCount > 0);
                    setBlacklist(['smbd:error:' + msgPattern], next);
                },
                // Reset ESDB and make sure no messages arrive.
                function(next) {
                    esdbServer.clear();

                    testHelpers.wait({
                        timeout: 30000, // Log record must arrive within 30 secs.
                        msg: 'Waiting for test log message not to arrive',
                        timeoutIsOk: true,
                        callback: function(cb) {
                            var logs = esdbServer.search({
                                index: indexName,
                                type: '_doc'
                            }).filter((msg) => {
                                return msg.message === testMessage;
                            });

                            assert.equal(logs.length, 0);
                            cb();
                        },
                        prepare: function(cb) {
                            // Inject test message.
                            worker.injectLogMessage({
                                message: logMsg
                            }, cb);
                        }
                    }, next);
                },
                // Reset blacklist to allow all messages flow.
                function(next) {
                    setBlacklist([], next);
                },
                // Inject test message one more time once no filters are active.
                function(next) {
                    apiAccessCount = 0;

                    worker.injectLogMessage({
                        message: logMsg
                    }, next);
                },
                // Wait for message to arrive.
                function(next) {
                    testHelpers.wait({
                        timeout: 30000, // Log record must arrive within 30 secs.
                        msg: 'Waiting for test log message to arrive once more',
                        callback: function(cb) {
                            var logs = esdbServer.search({
                                index: indexName,
                                type: '_doc'
                            }).filter((msg) => {
                                return msg.message === testMessage;
                            });

                            cb(undefined, logs.length > 0);
                        }
                    }, function() {
                        assert(apiAccessCount > 0);
                        next();
                    });
                }
            ], done);
        });

        it('resetting ESDB should stop sending logs to ESDB', function(done) {
            var msgPattern = 'unable to determine name for UUID';
            var testMessage = msgPattern + ': 10832';
            var logMsg = 'Dec 10 05:25:15 ' + cachedHostname +
                ' xyzdabc[700548]: [ID 802721 daemon.error]  ' + testMessage;
            var indexName = compoundUtils.getEventIndex('logs');
            var numEventsInjected = 0;

            async.series([
                // Reset blacklist to allow all messages flow.
                function(next) {
                    setBlacklist([], next);
                },
                // Inject test message.
                function(next) {
                    apiAccessCount = 0;

                    worker.injectLogMessage({
                        message: logMsg
                    }, next);
                },
                // Wait for message to arrive.
                function(next) {
                    testHelpers.wait({
                        timeout: 30000, // Log record must arrive within 30 secs.
                        msg: 'Waiting for test log message to arrive',
                        callback: function(cb) {
                            var logs = esdbServer.search({
                                index: indexName,
                                type: '_doc'
                            }).filter((msg) => {
                                return msg.message === testMessage;
                            });

                            cb(undefined, logs.length > 0);
                        }
                    }, next);
                },
                // Reset ESDB servers.
                function(next) {
                    compoundNode.updateEsdb([], next);
                },
                // Remove all existing ESDB messages abd inject test message.
                function(next) {
                    esdbServer.clear();

                    apiAccessCount = 0;
                    numEventsReceived = 0;
                    numEventsInjected = 1;

                    worker.injectLogMessage({
                        message: logMsg
                    }, next);
                },
                // Make sure no messages have arrived.
                function(next) {
                    testHelpers.wait({
                        timeout: 30000,
                        msg: 'Checking that no log messages have arrived',
                        timeoutIsOk: true,
                        callback: function(cb) {
                            // Inject log message every 1 second.
                            worker.injectLogMessage({
                                message: logMsg
                            }, (err) => {
                                assert.ifError(err);

                                numEventsInjected++;

                                var logs = esdbServer.search({
                                    index: indexName,
                                    type: '_doc'
                                }).filter((msg) => {
                                    return msg.message === testMessage;
                                });

                                assert.strictEqual(logs.length, 0,
                                    'Log message has arrived after ' +
                                    'resetting ESDB servers');
                                cb(undefined, false);
                            });
                        }
                    }, () => {
                        assert.strictEqual(apiAccessCount, 0,
                            'API invocations occurred when ESDB was offline');
                        next();
                    });
                },
                // Restore ESDB server and wait for all log messages.
                function(next) {
                    esdbServer.clear();

                    compoundNode.updateEsdb([
                        {
                            'url': 'http://127.0.0.1:9150'
                        }
                    ], next);
                },
                function(next) {
                    worker.injectLogMessage({
                        message: logMsg
                    }, next);
                },
                function(next) {
                    testHelpers.wait({
                        timeout: 30000,
                        msg: 'Checking that log messages have arrived',
                        callback: function(cb) {
                            var logs = esdbServer.search({
                                index: indexName,
                                type: '_doc'
                            }).filter((msg) => {
                                return msg.message === testMessage;
                            });

                            // Make sure all messages were received.
                            cb(undefined, numEventsReceived >= logs.length &&
                                logs.length === numEventsInjected);
                        }
                    }, next);
                }
            ], done);
        });
    });
});
