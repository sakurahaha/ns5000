var assert = require('assert');
var async  = require('async');
var logger = require('nef/logger');
var events = require('nef/events');
var _ = require('lodash');
var util = require('util');
var helpers = require('nef/testHelpers');
var Client = require('nef/client');
var EventEmitter = require('events').EventEmitter;
var nefUtils = require('nef/utils');
var config = nefUtils.requireConfig('testConfig/smtp');
var interop = require('nef/interop');

describe('logger.', function() {
    var worker;

    helpers.initSuite(this, {
        tag: 'vm',
    });

    before(function(done) {
        client = new Client('1.0', 'tcp://127.0.0.1:5557', {
            validateOutput: true
        });
        client.worker('logger', function(err, val) {
            assert.ifError(err);
            worker = val;
            done();
        });
    });

    describe('logger library', function() {
        before('prepare right loggerLevel', function() {
            logger.setLoggerLevel('trace');
        });

        it('should set new origin', function() {
            logger.origin('bdd-1');
        });

        it('should emit trace message', function(done) {
            waitLogEvent('bdd-1', 'trace', 'trace-message', done);
            logger.trace('trace-message');
        });

        it('should emit debug message', function(done) {
            waitLogEvent('bdd-1', 'debug', 'debug-message', done);
            logger.debug('debug-message');
        });

        it('should emit info message', function(done) {
            waitLogEvent('bdd-1', 'info', 'info-message', done);
            logger.info('info-message');
        });

        it('should emit warn message', function(done) {
            waitLogEvent('bdd-1', 'warn', 'warn-message', done);
            logger.warn('warn-message');
        });

        it('should emit error message', function(done) {
            waitLogEvent('bdd-1', 'error', 'error-message', done);
            logger.error('error-message');
        });

        it('should emit fatal message', function(done) {
            waitLogEvent('bdd-1', 'emerg', 'fatal-message', done);
            logger.fatal('fatal-message');
        });

        it('should change origin and log again', function(done) {
            logger.origin('bdd-2');

            waitLogEvent('bdd-2', 'info', 'info-message', done);
            logger.info('info-message');
        });
    });

    describe('set/get logger level', function() {
        it('should set logger level', function(done) {
            logger.setLoggerLevel('error');
            assert(logger.getLoggerLevel() === 'error');
            logger.setLoggerLevel('info');
            assert(logger.getLoggerLevel() === 'info');
            logger.setLoggerLevel('trace');
            assert(logger.getLoggerLevel() === 'trace');
            done();
        });

        it('should not send message', function(done) {
            const message = 'I am message';
            const origin = 'bdd-2';
            logger.setLoggerLevel('info');
            logger.origin(origin);
            logger.trace(message);
            checkLogEventAbsence(origin, 'trace', message, done);
        });

        it('should send message', function(done) {
            const message = 'I am message';
            const origin = 'bdd-2';
            logger.info(message);
            waitLogEvent(origin, 'info', message, done);
        });
    });

    describe('sendEmail()', function() {
        var origSmtpConfig = {};
        var origAdministratorEmail = null;
        var servers = config.servers || [];
        var mainServer = servers[0];

        if (!mainServer) {
            this.pending = true;
        }

        before('backup smtp settings', function(done) {
            async.series([
                (next) => {
                    interop.call('sysconfig', 'exportConfiguration', {
                        where: {
                            module: 'smtp',
                        }
                    }, (err, res) => {
                        origSmtpConfig = res;
                        next(err);
                    });
                },
                (next) => {
                    interop.call('sysconfig', 'getProperty', {
                        id: 'nef.administratorEmail'
                    }, (err, res) => {
                        origAdministratorEmail = res;
                        next(err);
                    });
                }
            ], done);
        });

        after('restore smtp settings', function(done) {
            async.series([
                (next) => {
                    interop.call('sysconfig', 'setProperty', {
                        id: 'nef.administratorEmail',
                        value: origAdministratorEmail,
                        persistent: false,
                    }, next);
                },
                (next) => {
                    helpers.wait({
                        message: 'Wait for SMTP configuration restore',
                        prepare: (next) => {
                            interop.call('sysconfig', 'importConfiguration', {
                                configuration: origSmtpConfig
                            }, next);
                        },
                        callback: (next) => {
                            interop.call('sysconfig', 'getJobStatus', {},
                                (err, res) => {
                                    next(err, res.status == 'done');
                                });
                        }
                    }, done);
                }
            ], done);
        });

        function configureSmtpServer(serv, done) {
            let conf = _.defaults({}, serv, config);
            interop.call('sysconfig', 'bulkSetProperties', {
                pairs: {
                    'nef.administratorEmail': conf['to'],
                    'smtp.senderEmail': conf['from'],
                    'smtp.host': conf['host'],
                    'smtp.port': conf['port'],
                    'smtp.user': conf['user'],
                    'smtp.password': conf['password'],
                    'smtp.authMethod': conf['authMethod'],
                    'smtp.security': conf['security'],
                    'smtp.timeout': conf['timeout'],
                    'smtp.rejectUnauthorized': conf['rejectUnauthorized'],
                    'smtp.debug': conf['debug']
                },
                persistent: false
            }, done);
        }

        it('should apply BROKEN settings and fail to send', function(done) {
            async.series([
                (next) => configureSmtpServer({
                    host: '127.0.0.1',
                    port: 255,   // Assume broken closed port on localhost
                }, next),
                (next) => {
                    logger.sendEmail({
                        subject: 'Broken email',
                        text: 'Should never arrive',
                    }, (err) => {
                        assert.errorIs('ECONNECTION', err);
                        next();
                    });
                }
            ], done);
        });

        it('should apply settings from first smtp server', function(done) {
            configureSmtpServer(mainServer, done);
        });

        it('should send test email with all fields', function(done) {
            logger.sendEmail({
                text: 'BDD test body',
                subject: 'BDD test email'
            }, done);
        });

        it('should send test email without subject', function(done) {
            logger.sendEmail({
                text: 'BDD test body'
            }, done);
        });

        servers.forEach((serv, idx) => {
            var id = `#${idx + 1} - ${serv.host}:${serv.port}`;
            it('should successfully use server ' + id, function(done) {
                async.series([
                    (next) => configureSmtpServer(serv, next),
                    (next) => {
                        logger.sendEmail({
                            subject: 'Test email to ' + id,
                            text: 'Test body to ' + id,
                        }, next);
                    }
                ], done);
            });

            if (serv.rejectUnauthorized === false) {
                it('should not use server ' + id +
                    ' with rejectUnauthorized = true', function(done) {
                    var newServ = _.defaults({
                        rejectUnauthorized: true
                    }, serv);
                    async.series([
                        (next) => configureSmtpServer(newServ, next),
                        (next) => {
                            logger.sendEmail({
                                subject: 'Test email to ' + id,
                                text: 'Test body to ' + id,
                            }, (err) => {
                                var allowed = ['ECONNECTION', 'ESOCKET'];
                                assert(allowed.indexOf(err.code) > -1);
                                next();
                            });
                        }
                    ], done);
                });
            }
        });
    });
});

/**
 * Helper hub for logevents, so we can subscribe and unsubscribe
 * without problems
 */
var hub = new EventEmitter();

events.private.on('NEF_logger_message', function(message) {
    hub.emit('message', message);
});

/**
 * Function waits for log level with given
 * parameters or exits with assert error
 */
function waitLogEvent(origin, severity, text, done) {
    listenLogEvent({
        origin,
        severity,
        text,
        eventShouldCome: true,
        done
    });
}

/**
 * Function check that log event has not come
 */
function checkLogEventAbsence(origin, severity, text, done) {
    listenLogEvent({
        origin,
        severity,
        text,
        eventShouldCome: false,
        done
    });
}

function listenLogEvent(options) {
    const {origin, severity, text, done, eventShouldCome} = options;
    var listener;
    var resetter;
    var tobj;

    listener = function(msg) {
        if (msg.origin !== origin) {
            return;
        }

        if (msg.severity !== severity) {
            return;
        }

        if (msg.msg.toString() !== text) {
            return;
        }

        if (eventShouldCome) {
            resetter();
            done();
        } else {
            resetter();
            var msg = util.
            format('Message [origin=%s, sev=%s, msg=%s] has arrived',
                origin, severity, text);
            assert.fail(msg);
        }
    };

    resetter = function() {
        hub.removeListener('message', listener);
        clearTimeout(tobj);
    };

    tobj = setTimeout(function() {
        if (eventShouldCome) {
            var msg = util.
            format('Message [origin=%s, sev=%s, msg=%s] has not arrived',
                origin, severity, text);
            resetter();
            assert.fail(msg);
        } else {
            resetter();
            done();
        }

    }, 1000);

    hub.on('message', listener);
}

