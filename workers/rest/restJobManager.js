/**
 * @fileOverview Manager of async jobs created for 202 REST operations.
 * Copyright (C) 2014  Nexenta Systems, Inc
 * All rights reserved.
 */

var uuidGen   = require('node-uuid');
var nef       = require('nef');
var utils     = require('nef/utils');
var restUtils = require('nef/restUtils');
var NefError  = require('nef/error').NefError;

var restJobManager = {}; // exported stuff
var asyncJobs = {}; // Temporary solution, it will go to DB
var TIMEOUT_NOT_RESPONDED = 60 * 60; // 1 hour
var TIMEOUT_RESPONDED = 5 * 60; // 5 minutes

// Fields needed to be backed up from original request when conserving its state
var requestFieldsCopy = [
    'headers',
    'trailers',
    'url',
    'method',
    'statusCode',
    'params',
    'query',
    'server',
    'body',
    // our rest server specific params
    'responseStatus',
    'responseHeaders',
    'metadata',
    // cached info in request
    '_path',
    '_query',
    '_href',
    '_url',
    '_version',
];

/**
 * Long operation status class
 *
 * @param {Object}   req       Original request (request which got interrupted
 *                             by 202)
 * @param {Function} deleteCb  Callback used to remove route in REST server
 *                             when job is deleted.
 */
function AsyncJob(req, deleteCb) {
    var self = this;

    self.id = uuidGen.v1();
    self.url = '/jobStatus/' + self.id;
    self.origUrl = req.getHref();
    self.req = req;
    self.progress = 0;
    self.startTime = new Date();
    self.finishTime = null;
    self.isDone = false;
    self.respondedTimer = null;
    self.notRespondedTimer = null;
    self.jobDeletedCallback = deleteCb;
    self.description = null;
    self.version = req.apiVersion;

    self.setProgress = function(processed, description, total) {
        if (processed === undefined) {
            self.progress++;
        } else {
            self.progress = processed;
        }

        if (description) {
            self.description = description;
        }
    };

    /**
     * Get representation of the async job as seen by http client.
     */
    self.represent = function() {
        var res = {
            jobId: self.id,
            progress: self.progress,
            originalMethod: self.req.method,
            originalUrl: self.origUrl,
            startTime: self.startTime.toISOString(),
            done: self.isDone,
        };
        if (self.isDone) {
            res.finishTime = self.finishTime.toISOString();
        }
        if (self.description) {
            res.description = self.description;
        }

        return res;
    };

    /**
     * Generate method descriptor for obtaining status of this job.
     */
    self.genStatusMdesc = function() {
        return {
            id: 'getJobStatus' + self.id,
            version: self.version.toString(),
            action: 'read',
            url: self.url,
            description: 'Get detail of async job ' + self.id,
            handler: self.statusHandler,
            schemas: {
                output: statusSchema
            },
            parent: {},
            children: [],
            advanced: {}
        };
    };

    /**
     * Generate method descriptor for obtaining result of this job.
     */
    self.genResultMdesc = function() {
        return {
            id: 'getJobResult' + self.id,
            version: self.version.toString(),
            action: 'read',
            url: self.url,
            description: 'Get result of async job ' + self.id,
            handler: self.resultHandler,
            schemas: {},
            parent: {},
            children: [],
            advanced: {}
        };
    };

    /**
     * Called when original request ends with 202 status.
     */
    self.redirectToMonitor = function(req, res, payload, next) {
        var data = {
            links: [{
                rel: 'monitor',
                href: self.url
            }]
        };

        if (next === undefined) {
            next = payload;
            payload = undefined;
        }

        res.header('Location', self.url);
        if (payload) {
            utils.extend(data, payload);
        }
        res.send(202, data);
        next(false);
    };

    /**
     * Generate a status information with 202 code.
     */
    self.statusHandler = function(req, done) {
        req.metadata.links.push({
            rel: 'monitor',
            href: self.url
        });
        req.metadata.links.push({
            rel: 'original',
            href: self.origUrl
        });
        req.responseHeaders['Location'] = self.url;
        req.responseStatus = 202;
        done(null, self.represent());
    };

    /**
     * Restores context of the request interrupted by 202.
     */
    self.resultHandler = function(req, done) {
        if (!asyncJobs[self.id]) {
            return done(NefError('ENOENT', __('No such job')));
        }

        // Restore the original request
        requestFieldsCopy.forEach(function(field) {
            req[field] = self.req[field];
        });

        if (self.notRespondedTimer) {
            clearTimeout(self.notRespondedTimer);
            self.notRespondedTimer = null;
        }
        if (!self.respondedTimer) {
            self.respondedTimer = setTimeout(function() {
                delete asyncJobs[self.id];
                self.jobDeletedCallback(self);
            }, 1000 * TIMEOUT_RESPONDED);
        }
        done(self.jobError, self.jobResult);
    };

    /**
     * Called when the async job is done.
     */
    self.done = function(err, res) {
        self.isDone = true;
        self.finishTime = new Date();
        self.jobError = err;
        self.jobResult = res;

        self.notRespondedTimer = setTimeout(function() {
            delete asyncJobs[self.id];
            self.jobDeletedCallback(self);
        }, 1000 * TIMEOUT_NOT_RESPONDED);
    };

    return self;
}

/**
 * Read collection with pagination support.
 */
function collectionReadHandler(req, done) {
    var objs = Object.keys(asyncJobs).map(function(id) {
        return asyncJobs[id].represent();
    });

    objs = restUtils.filterResult(objs, req.query,
            ['limit', 'offset', 'fields']);
    objs = restUtils.fitPage(req, objs);

    done(null, objs);
}

/**
 * Create a new async job.
 */
restJobManager.createAsyncJob = function(req, deleteCb) {
    var result = new AsyncJob(req, deleteCb);
    asyncJobs[result.id] = result;
    return result;
};

/*
 * Description of status object.
 */
var statusSchema = {
    type: 'object',
    properties: {
        jobId: {
            type: 'string',
            description: 'ID of job status',
            required: true
        },
        // TODO: design progress information better (ETA, percents, etc.)
        progress: {
            type: 'integer',
            description: 'Opaque progress value (the higher the better)'
        },
        originalMethod: {
            type: 'string',
            enum: ['POST', 'PUT', 'DELETE'],
            description: 'Method which caused the asynchronous job',
            required: true
        },
        originalUrl: {
            type: 'string',
            description: 'URL which caused the asynchronous job',
            required: true
        },
        startTime: {
            type: 'string',
            format: 'date-time',
            description: 'Time when asynchronous job started',
            required: true
        },
        finishTime: {
            type: 'string',
            format: 'date-time',
            description: 'Time when asynchronous job finished',
        },
        done: {
            type: 'boolean',
            description: 'False if the job is in progress. True if done.',
            required: true
        },
        description: {
            type: 'string',
            description: 'Brief summary for progress',
            required: false
        }
    },
    additionalProperties: false
};

/*
 * Api description for async job statuses.
 */
restJobManager.jobManagerApi = {
    name: 'Job status API',
    collections: [{
        id: 'jobStatus',
        description: 'Collection of asynchronous request statuses',
        allowedZones: ['global', 'non-global'],
        objectSchema: statusSchema,
        objectName: 'status',
        url: '/jobStatus',
        key: 'jobId',
        handler: collectionReadHandler,
        methods: {}
    }]
};

module.exports = restJobManager;
