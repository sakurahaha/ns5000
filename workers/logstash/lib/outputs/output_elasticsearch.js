/**
 * Copyright (C) 2014, 2018  Nexenta Systems, Inc
 * All rights reserved.
 */

var baseOutput = require('../lib/base_output');
var util = require('util');
var logger = require('nef/logger');
var SampleBucket = require('nef/statsUtils').SampleBucket;
var jsonschema = require('jsonschema');
var logSchema = require('nef/compoundUtils').CompoundLogMessageSchema;
var assert = require('assert');
var url = require('url');
var async = require('async');
var compoundUtils = require('nef/compoundUtils');

/*
 * Create a REST/ElasticSearch clients in advance. They will be reconfigured
 * upon node attach.
 */
var restClient = compoundUtils.createFedRestClient();

var esClient;

var retryIdx = 0;
// Show error for every 5th failure, to prevent screen pollution with error
// messages.
var retryShowRate = 5;

/* Helper class for merging multpart messages. */
var MessageMerger = function(delay, fn) {
    this.fn = fn;
    this.delay = delay;
    this.lastMessage = null;
    this.timerId = null;
};

MessageMerger.prototype.addMessage = function(msg) {
    var self = this;

    if (msg.isMultipart) {
        // If a part arrives after the deadline, don't use it.
        if (self.lastMessage) {
            self.lastMessage.message = (self.lastMessage.message +
                ' ' + msg.message);
        }
    } else {
        var last = self.lastMessage;

        if (self.timerId) {
            clearTimeout(self.timerId);
            self.timerId = null;
        }
        self.lastMessage = msg;

        self.timerId = setTimeout(function() {
            self.timerId = null;
            self.fn(self.lastMessage);
            self.lastMessage = null;
        }, self.delay);

        if (last) {
            self.fn(last);
        }
    }
};

function notifyFusionLog(docs, done) {
    var records = compoundUtils.removeNotyfied(docs);
    if (records.length === 0) {
        return done();
    }

    restClient.notifyLog(records, (err) => {
        if (err) {
            if ((retryIdx % retryShowRate) === 0) {
                logger.error(__('Failed to notify compound about log ' +
                                'record: %s', err.toString()));
            }
            retryIdx++;
        } else {
            // Reset retry counter in case of success.
            logger.debug(__('Notified Fusion about %s log record(s)',
                            records.length));
            retryIdx = 0;
        }
        done();
    });
}

function sendToDatabase(records, done) {
    var commands = [];
    var notProcessed;

    if (!esClient) {
        logger.warn(__('No ESDB configured, resending log records'));
        notifyFusionLog(records, (err) => {
            done(compoundUtils.setNotyfied(records));
        });
        return;
    }

    async.waterfall([
        // First check if ESDB is available.
        (next) => {
            notProcessed = records;
            esClient.checkDbAccessibility(next);
        },
        // In case ESDB is not available, retransmit all documents.
        (available, next) => {
            if (!available) {
                logger.debug(__('ESDB not available, retransmitting %d doc(s)',
                                records.length));
                return notifyFusionLog(records, next);
            }

            var indexName = compoundUtils.getEventIndex('logs');

            records.forEach(function(record) {
                /* Make sure event object meets the schema. */
                var res = jsonschema.validate(record, logSchema);

                if (res.errors.length > 0) {
                    logger.error(__('Insufficient log message: %s. Ignoring.',
                        JSON.stringify(record)));
                    return;
                }

                /* Add metadata and record data. */
                commands.push({index: {
                    _index: indexName,
                    _type: '_doc'
                }});
                commands.push(record);
            });

            /* All records are bad. */
            if (commands.length === 0) {
                notProcessed = undefined;
                return next();
            }

            /* Do a bulk update. */
            esClient.bulk({
                body: commands
            }, (error, resp) => {
                if (error) {
                    if ((retryIdx % retryShowRate) === 0) {
                        var errMsg = error.message.indexOf(
                            'No Living connections') === -1 ? error.message :
                            'check accessibility/operability of the database';

                        logger.error(__('Failed to push event to ' +
                                        'ElasticSearch server: %s', errMsg));
                    }
                    retryIdx++;
                    /* In case of error return not-processed records
                     * to the bucket.
                     */
                    return notifyFusionLog(records, next);
                }

                // Reset retry counter in case of success.
                logger.debug(__('Pushed %s log records to ESDB, notifying ' +
                                'Fusion', records.length));

                // After successfull ESDB transfer no more retransmittions
                // required.
                notProcessed = undefined;

                restClient.notifyLog(records, (err) => {
                    if (err) {
                        if ((retryIdx % retryShowRate) === 0) {
                            logger.error(__('Failed to notify compound ' +
                                            'about log record: %s',
                                            err.toString()));
                        }
                        retryIdx++;
                    } else {
                        // Reset retry counter in case of success.
                        logger.debug(__('Notified Fusion about %s log ' +
                                        'record(s)', records.length));
                        retryIdx = 0;
                    }
                    next();
                });
            });
        }
    ], () => {
        done(compoundUtils.setNotyfied(notProcessed));
    });
};

function OutputElasticSearch() {
    baseOutput.BaseOutput.call(this);
    this.mergeConfig({
        name: 'OutputElasticSearch',
    });

    /* Threshold is 1 log records (or 5 sec. timeout), max. 300 log records. */
    this.sampleBucket = new SampleBucket(sendToDatabase, 1, 5, 300);

    var self = this;
    this.merger = new MessageMerger(5000, function(msg) {
        self.sampleBucket.addSample(msg);
    });
};

util.inherits(OutputElasticSearch, baseOutput.BaseOutput);

OutputElasticSearch.prototype.configureElasticSearch = function(cfg) {
    restClient.configure(cfg);

    // Configure ElasticSearch client.
    if (!esClient) {
        esClient = compoundUtils.createFedElasticSearchClient(cfg);
    } else {
        esClient.configure(cfg);
    }
};

OutputElasticSearch.prototype.enable = function(enable) {
    this.sampleBucket.enable(enable);
};

OutputElasticSearch.prototype.process = function(data) {
    // If no ElasticSearch endpoint configured, ifnore the data.
    if (!esClient) {
        return;
    }
    this.merger.addMessage(data);
};

exports.create = function() {
    return new OutputElasticSearch();
};
