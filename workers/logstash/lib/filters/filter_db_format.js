/**
 * Logstash worker DB record filter.
 * Copyright (C) 2014  Nexenta Systems, Inc.
 * All rights reserved.
 */

var logger = require('nef/logger');
var baseFilter = require('../lib/base_filter');
var util = require('util');

function FilterSyslogPri() {
    baseFilter.BaseFilter.call(this);
    this.mergeConfig({
        name: 'DBFormat'
    });
}

util.inherits(FilterSyslogPri, baseFilter.BaseFilter);

var msgPatterns = [
    /* User message: has PID.
     * Parsed message has the following structure (indexes start with 1):
     *   1) Month
     *   2) Date
     *   3) Time (hh:mm:ss)
     *   4) Hostname
     *   5) progname/PID
     *   6) ID tag
     *   7) Message ID
     *   8) facility.severity
     *   9) PID
     *   10) Message
     */
    {
        regexp: new RegExp('^(\\w+)\\s+(\\d+)\\s+([0-9:]+)\\s(\\S+)\\s+' +
            '(\\S+)\\s+\\[(\\w+)\\s+(\\d+)\\s+(\\S+)\\]\\s+(\\d+)\\s+(.+)$'),
        facsev: 8,
        fields: {
            hostname: 4,
            component: 5,
            message: 10
        }
    },

    /* System messages: no PID.
     * Parsed message has the following structure (indexes start with 1):
     *   1) Month
     *   2) Date
     *   3) Time (hh:mm:ss)
     *   4) Hostname
     *   5) progname/PID
     *   6) ID tag
     *   7) Message ID
     *   8) facility.severity
     *   9) Message
     */
    {
        regexp: new RegExp('^(\\w+)\\s+(\\d+)\\s+([0-9:]+)\\s+(\\S+)\\s+' +
            '(\\S+)\\s+\\[(\\w+)\\s+(\\d+)\\s+(\\S+)\\]\\s+(.+)$'),
        facsev: 8,
        fields: {
            hostname: 4,
            component: 5,
            message: 9
        }
    },

    /* NEF messages (Solaris syslog).
     * Parsed message has the following structure (indexes start with 1):
     *   1) Month
     *   2) Date
     *   3) Time (hh:mm:ss)
     *   4) Hostname
     *   5) NEF label (NEF)
     *   6) Worker name
     *   7) facility.severity
     *   8) Message
     */
    {
        regexp: new RegExp('^(\\w+)\\s+(\\d+)\\s+([0-9:]+)\\s+(\\S+)\\s+' +
            'NEF\\s+(\\w+):\\s+\\[(\\w+\\.\\w+)\\]\\s+(.+)$'),
        facsev: 6,
        fields: {
            hostname: 4,
            component: 5,
            message: 7
        }
    },

    /* NEF messages (Linux syslog).
     * Parsed message has the following structure (indexes start with 1):
     *   1) Month
     *   2) Date
     *   3) Time (hh:mm:ss)
     *   4) Hostname
     *   5) NEF label (NEF)
     *   6) Worker name
     *   7) facility.severity
     *   8) Message
     */
    {
        regexp: new RegExp('^(\\w+)\\s+(\\d+)\\s+([0-9:]+)\\s+(\\S+)\\s+' +
            'NEF: NEF\\s+(\\w+)\\s+(\\w+\\.\\w+)\\s+(.+)$'),
        facsev: 6,
        fields: {
            hostname: 4,
            component: 5,
            message: 7
        }
    },

    /* Multipart message's part.
     *   1) Month
     *   2) Date
     *   3) Time (hh:mm:ss)
     *   4) Hostname
     *   5) Message
     */
    {
        regexp: new RegExp('^(\\w+)\\s+(\\d+)\\s+([0-9:]+)\\s+(\\S+)\\s+' +
            '(.+)$'),
        isMultipart: false,
        fields: {
            message: 5,
            hostname: 4
        }
    }
];

function _parseMessage(message) {
    for (var idx = 0; idx < msgPatterns.length; idx++) {
        var parsed = message.match(msgPatterns[idx].regexp);

        if (parsed) {
            return {
                parsed: parsed,
                facsev: msgPatterns[idx].facsev,
                fields: msgPatterns[idx].fields,
                isMultipart: msgPatterns[idx].isMultipart
            };
        }
    }
    return null;
};

var cachedHostId = null;
var cachedOrigin = null;

// Severity level for multipart messages.
var lastSeverity = null;

function parseLogMessage(message) {
    var parsedRec = _parseMessage(message);
    var record = {};

    if (!parsedRec) {
        return null;
    }

    var parsed = parsedRec.parsed;
    var fields = parsedRec.fields;

    /* Setup common fields. */
    Object.keys(fields).forEach(function(key) {
        record[key] = parsed[fields[key]];
    });

    // Translate hostname.
    if (record.hostname) {
        record.hostName = record.hostname;
        delete record.hostname;
    }

    // Remove PID from the component.
    if (record.component) {
        var idx = record.component.indexOf('[');

        if (idx !== -1) {
            record.component = record.component.substring(0, idx);
        }
    }

    /* Setup facility/severity. */
    if (parsedRec.facsev) {
        var facSev = parsed[parsedRec.facsev].split('.');
        if (facSev.length !== 2) {
            logger.error(__('Insufficient facility/severity record: %s',
                parsed[parsedRec.facsev]));
            return null;
        }

        // Save severity for (possibly) multiple parts.
        lastSeverity = facSev[1];

        record['facility'] = facSev[0];
        record['severity'] = lastSeverity;
    } else {
        // First message can also be without explicit severity, so
        // optimistically assume INFO severity and DAEMON facility.
        record.severity = 'info';
        record.facility = 'daemon';

        // Try to extract component if it's passed in this form:
        //    component[pid]: message.
        var pidIdx = record.message.indexOf('[');
        if (pidIdx > 0 && pidIdx < record.message.indexOf(':')) {
            record.component = record.message.substring(0, pidIdx);
        } else {
            record.component = 'unknown';
        }
    }

    if (!record.component) {
        record.component = 'unknown';
    }

    /*
     * Setup timestamp. Since log message doesn't contain the year,
     * we obtain the year explicitly.
     */
    var date = new Date(__('%s %s, %s %s', parsed[1], parsed[2],
        new Date().getFullYear(), parsed[3]));
    record['timestamp'] = date.toISOString();

    /* Apply hostID and origin. */
    record['hostId'] = cachedHostId;
    record['origin'] = cachedOrigin;

    return record;
};

FilterSyslogPri.prototype.configure = function(hostId, origin) {
    cachedHostId = hostId;
    cachedOrigin = origin;
};

FilterSyslogPri.prototype.process = function(data) {
    return parseLogMessage(data.message);
};

exports.create = function() {
    return new FilterSyslogPri();
};
