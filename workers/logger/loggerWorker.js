#!/usr/bin/env node

/*
 * Copyright (C) 2015 Nexenta Systems, Inc
 * All rights reserved.
 */
'use strict';
var worker = require('nef/baseWorker');
var events = require('nef/events');
var logger = require('nef/logger');
var util = require('util');
var nefUtils = require('nef/utils');
const _ = require('lodash');

var commonConfig = nefUtils.requireConfig('config/common');
var smtp = require('nef/smtp');
var syslog = require('modern-syslog');

worker.info(require('./worker.json'));

var syslogPriorities = {
    trace: syslog.LOG_DEBUG,
    debug: syslog.LOG_DEBUG,
    info: syslog.LOG_NOTICE,
    warn: syslog.LOG_WARNING,
    // NEF errors should never go to the console (NEX-6788)
    // hence no 'error' severity and above
    error: syslog.LOG_WARNING,
    emerg: syslog.LOG_WARNING
};

var syslogFacilities = {
    daemon: syslog.LOG_DAEMON,
    local0: syslog.LOG_LOCAL0,
    local1: syslog.LOG_LOCAL1,
    local2: syslog.LOG_LOCAL2,
    local3: syslog.LOG_LOCAL3,
    local4: syslog.LOG_LOCAL4,
    local5: syslog.LOG_LOCAL5,
    local6: syslog.LOG_LOCAL6,
    local7: syslog.LOG_LOCAL7,
};

/**
 * Initialize syslog. Detect facility
 */
var writeSyslog = commonConfig.loggerEnableSyslog;
var facilityId = syslogFacilities[commonConfig.loggerSyslogFacility];
if (!facilityId) {
    logger.error(__('Unsupported facility "%s". Supported: %s',
                    commonConfig.loggerSyslogFacility,
                    Object.keys(syslogFacilities).join(', ')));
    writeSyslog = false;
}

if (writeSyslog) {
    logger.info(__('Enable logging to syslog with facility "%s"',
                    commonConfig.loggerSyslogFacility));
    syslog.open(commonConfig.procmanAppIdent, syslog.LOG_ODELAY, facilityId);
}

/**
 * Different writers
 */
var syslogWriter = function(message) {
    const msg = syslogFormat(message);
    syslog.log(syslogPriorities[message.severity], msg);
};

function syslogFormat(message) {
    if (commonConfig.loggerSyslogPretty) {
        const origin = _.padStart(message.origin, 13, ' ').slice(0, 13);
        const severity = _.padStart(message.severity, 5, ' ').slice(0, 5);
        return util.format('[%s] [%s] %s', origin, severity, message.msg);
    }

    return util.format('%s daemon.%s %s', message.origin,
        message.severity, message.msg);
}

var logWrite = function(message) {
    logger.screenWriter(message);

    if (writeSyslog) {
        logger.stripColors(message);
        syslogWriter(message);
    }
};

worker.apiMethod('sendEmail', {
    description: 'Send mail to administrator',
    restType: 'PUT',
    input: {
        text: {
            description: 'Body of the letter',
            type: 'string',
            required: true
        },
        subject: {
            description: 'Subject of the letter',
            type: 'string'
        },
        origin: {
            desciption: 'Origin of the sender, used for autogenerate',
            type: 'string'
        }
    },
    output: {}
}, function(args, done) {
    smtp.sendEmail({
        toProperty: 'nef.administratorEmail',
        subject: args.subject || __('Letter from nef.%s',
            args.origin || 'core').toString(),
        text: args.text
    }, (err) => done(err));
});

events.private.on('NEF_logger_message', logWrite);

worker.start();
