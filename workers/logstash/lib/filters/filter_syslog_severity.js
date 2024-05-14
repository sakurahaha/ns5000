/**
 * @FileOverview Logstash worker severity filter.
 * Copyright (C) 2014  Nexenta Systems, Inc.
 * All rights reserved.
 */

var logger = require('nef/logger');
var base_filter = require('../lib/base_filter');
var util = require('util');
var nef = require('nef');
var logger = require('nef/logger');

function FilterSyslogPri() {
    this.enabled = true;
    base_filter.BaseFilter.call(this);
    this.mergeConfig({
        name: 'SyslogSeverity'
    });
};

/* Known severity levels and their relative priorities. */
var severityLabels = {
    emergency: 7,
    alert:     6,
    critical:  5,
    error:     4,
    warning:   3,
    notice:    2,
    info:      1,
    debug:     0
};

util.inherits(FilterSyslogPri, base_filter.BaseFilter);

/* Allowed severity level. */
var logLevel = 'warning';

FilterSyslogPri.prototype.process = function(data) {
    if (data.severity && this.enabled) {
        /* Workaround for severity level mismatch. */
        if (data.severity === 'emerg') {
            data.severity = 'emergency';
        } else if (data.severity === 'crit') {
            data.severity = 'critical';
        }

        if (severityLabels.hasOwnProperty(data.severity)) {
            if (severityLabels[data.severity] >= severityLabels[logLevel]) {
                return data;
            }
        }
    }
    return null;
};

FilterSyslogPri.prototype.setSeverityLevel = function(level) {
    if (severityLabels.hasOwnProperty(level)) {
        logLevel = level;
        logger.info(__('Changing severity level to: %s', level));
    } else {
        logger.error(__('Insufficient severity level: %s', level));
    }
};

FilterSyslogPri.prototype.enable = function(enable) {
  this.enabled = enable;
};

FilterSyslogPri.prototype.getSeverityLevel = function(done) {
    done(null, logLevel);
};

exports.create = function() {
    return new FilterSyslogPri();
};
