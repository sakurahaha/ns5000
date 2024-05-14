/**
 * Initialization logic for the Logstash worker.
 * Copyright (C) 2014, 2017  Nexenta Systems, Inc
 * All rights reserved.
 */

var logger = require('nef/logger');
var worker = require('nef/fedWorker');
var NefError = require('nef/error').NefError;
var agent = require('./lib/agent');
var async = require('async');
var interop = require('nef/interop');
var nefUtils = require('nef/utils');
var WorkerConfig = require('nef/worker/config');
var compoundUtils = require('nef/compoundUtils');
var schemaUtils = require('nef/schemaUtils');
var auxInput = require('./lib/inputs/input_aux.js');

var logstashAgent = null;

var serverHost = '';
var serverPort = 0;
var logstashConfig = null;
var origin = null;

function doAttachDetach(cfg, done) {
    var filter = logstashAgent.getFilterModule('syslog_severity');
    if (!filter) {
        done(NefError('ENOENT', __('No severity filter installed')));
        return;
    }

    var esOutput = logstashAgent.getOutputModule('elasticsearch');
    if (!esOutput) {
        done(NefError('ENOENT', __('No ElasticSearch output installed')));
        return;
    }

    if (cfg) { // Attach.
        esOutput.configureElasticSearch(cfg);
    }

    /* Adjust the filter and output module. */
    filter.enable(cfg !== undefined);
    esOutput.enable(cfg !== undefined);

    done();
}

function logstashAttach(cfg, done) {
    doAttachDetach(cfg, done);
}

function logstashDetach(done) {
    doAttachDetach(undefined, done);
}

function logstashReconfigure(cfg, done) {
    doAttachDetach(cfg, done);
}

function logstashInitialize(federated, cfg, done) {
    if (federated) {
        logstashAttach(cfg, done);
    } else {
        done();
    }
};

function setupBlacklist() {
    if (!logstashAgent) {
        return;
    }

    var filter = logstashAgent.getFilterModule('message_blacklist');
    if (!filter) {
        logger.error('Can not apply message blacklist level: ' +
            'no blacklist filter installed');
        return;
    }

    filter.setBlacklist(logstashConfig.get('messageBlacklist'));
};

function setupLogstashProperties(logstashWorker) {
    logstashConfig = new WorkerConfig({
        version: 1,
        worker: logstashWorker,
        publicNamePrefix: 'logger.',
        properties: [{
            name: 'logSeverity',
            description: 'Log severity level threshold',
            schema: compoundUtils.severitySchema,
            default: compoundUtils.defaultLogSeverity
        }, {
            name: 'messageBlacklist',
            publicName: true,
            description: __('Patterns for blacklisting log messages'),
            default: [],
            schema: {
                type: 'array',
                items: {
                    type: 'string'
                }
            }
        }]
    });

    /* Configure property listeners. */
    logstashConfig.on('changed:logSeverity', function() {
        var filter = logstashAgent.getFilterModule('syslog_severity');
        if (!filter) {
            logger.error('Can not change severity level: ' +
                'no severity filter installed');
            return;
        }

        filter.setSeverityLevel(logstashConfig.get('logSeverity'));
    });

    logstashConfig.on('changed:messageBlacklist', function() {
        setupBlacklist();
    });
};

function injectMessageHandler(message, done) {
    var aux = auxInput.getInstance();
    if (!aux) {
        return done(NefError('EFAILED',
            __('No AUX input module available')));
    }

    aux.inject(message);
    done();
};

function initializeMethods(worker) {
    worker.apiMethod('injectLogMessage', {
        input: {
            message: {
                type: 'string',
                description: 'Log message to inject',
                required: true
            }
        },
        output: schemaUtils.common.nullOutput
    }, function(args, done) {
        injectMessageHandler(args.message, done);
    });
};

function initialize(logstashWorker, done) {
    if (logstashAgent) {
        done();
        return;
    }

    /* Initialize methods. */
    initializeMethods(logstashWorker);

    /* Initialize config. */
    setupLogstashProperties(logstashWorker);

    async.series([
        logstashConfig.init.bind(logstashConfig),
        /* Initialize compound utils. */
        compoundUtils.initialize,

        /* Create and start the logstash agent. */
        function(next) {
            logstashAgent = agent.create();

            var logfile = worker.isAtomicNode() ? '/var/adm/messages' :
                '/var/log/syslog';

            var cfg = [
                nefUtils.format('input://file://%s?use_tail=true', logfile),
                'input://aux://',
                'output://elasticsearch://',
                'filter://db_format://',
                'filter://syslog_severity://',
                'filter://message_blacklist://'
            ];

            logstashAgent.start(cfg, next);
        },

        // Configure filters.
        function(next) {
            // Perform initial blacklist configuration.
            setupBlacklist();

            // Drop all messages until the ES server is configured.
            var filter = logstashAgent.getFilterModule('syslog_severity');
            if (!filter) {
                next(NefError('ENOENT', __('No severity filter installed')));
            } else {
                filter.enable(false);

                /* Initialize severity level. */
                filter.setSeverityLevel(logstashConfig.get('logSeverity'));
                next();
            }
        },

        /* Configure hostId/origin. */
        function(next) {
            var filter = logstashAgent.getFilterModule('db_format');
            if (!filter) {
                next(NefError('ENOENT', __('No format filter installed')));
            } else {
                var origin = worker.isAtomicNode() ? 'atomic' : 'compound';
                filter.configure(compoundUtils.getHostId(), origin);
                next();
            }
        },

        /* Initialize worker. */
        function(next) {
            var wConfig = {
                properties: compoundUtils.defaultFedWorkerProperties,
                initialize: logstashInitialize,
                attach: logstashAttach,
                detach: logstashDetach,
                reconfigure: logstashReconfigure
            };

            logstashWorker.configure(wConfig);
            next();
        }
    ], function(err) {
        if (err) {
            logger.error('Failed to initialize logstash agent. ' +
                err.toString());
        } else {
            logger.info('Logstash agent initialized successfully');
        }
        done(err);
    });
}

module.exports = {
    initialize: initialize
};
