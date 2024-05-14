/**
 * @fileOverview Procman worker's API.
 */

'use strict'

var async = require('async');

var worker = require('nef/baseWorker');
var events = require('nef/events');
var Finder = require('nef/finder');
var schemaUtils = require('nef/schemaUtils');
var NefError = require('nef/error').NefError;
var interop = require('nef/interop');
var nefUtils = require('nef/utils');

var procman  = worker.procman;
var schemas  = require('./procmanSchemas');

/* Procman events declaration */

events.declare('NEF_procman_process_started', {
    description: 'A worker module has been started',
    range: 'joint',
    payload: schemas.workerStartEvent
});

events.declare('NEF_procman_process_stopped', {
    description: 'A worker module has been stopped',
    range: 'joint',
    payload: schemas.workerStopEvent
});

events.declare('NEF_procman_process_online', {
    description: 'A worker module is connected to the broker',
    range: 'joint',
    payload: {
        description: 'Name of the worker',
        type: 'string',
        required: true
    }
});

events.declare('NEF_procman_process_offline', {
    description: 'A worker module is disconnected from the broker',
    range: 'joint',
    payload: {
        description: 'Name of the worker',
        type: 'string',
        required: true
    }
});

events.declare('NEF_procman_start_complete', {
    description: 'All workers are online and start up is complete',
    range: 'joint',
    payload: {
        type: 'object',
        additionalProperties: false,
        properties: {
            online: {
                type: 'integer',
                description: 'Number of online worker'
            },
            failed: {
                type: 'integer',
                description: 'Number of failed worker'
            },
            failedWorkers: {
                type: 'array',
                description: 'List of failed worker',
                items: {
                    type: 'string'
                }
            }
        }
    }
});

/* Procman API methods */

var finder = new Finder({
    scheme: schemas.worker.properties,
    input: {
        includeUsage: {
            description: 'Include cpu and mem usage',
            type: 'boolean'
        },
        includeStats: {
            description: 'Include broker statistics',
            type: 'boolean'
        }
    },
    getAll: function(context, done) {
        var res = procman.workers.find().map((worker) => {
            return worker.toObject();
        });
        done(undefined, res);
    },
    afterPaginate: function(context, result, done) {
        async.parallel({
            updateUsage: (next) => {
                if (!context.includeUsage) {
                    return next();
                }

                async.eachLimit(result, 4, (data, next) => {
                    var worker = procman.workers.get(data.name);
                    if (!worker) {
                        return next();
                    }

                    worker.usage((err, res) => {
                        if (err) {
                            return next(err);
                        }
                        nefUtils.extend(data, res);
                        next();
                    });
                }, next);
            },
            updateStats: (next) => {
                if (!context.includeStats) {
                    return next();
                }

                interop.call('broker', 'getStats', {}, (err, res) => {
                    if (err) {
                        return next(err);
                    }

                    var byName = nefUtils.arrayToDict(res, 'name');
                    for (var data of result) {
                        if (data.name in byName) {
                            data.stats = byName[data.name].stats;
                        }
                    }
                    next();
                });
            }
        }, done);
    }
});
finder.apiMethod(worker, 'findWorkers', 'Find workers which match given query');

worker.apiMethod('enableWorker', {
    description:
        'Enable the specified process. This command will run the process and ' +
        'respawn it automatically. Enabled status is stored persistently. So ' +
        'if the process is enabled, it will start automatically on every boot.',
    input: {
        name: {
            description: 'Name of the worker',
            type: 'string',
            required: true
        }
    },
    output: schemaUtils.common.nullOutput,
    locks: ['procman']
}, function(args, callback) {
    procman.workers.with(args.name, (worker, next) => {
        if (worker.enabled) {
            next(NefError('EEXIST', __('Worker %s has been already started',
                                       worker.name)));
        } else {
            worker.enable({
                cause: __('Enabled by API call'),
                enableRequired: true,
                logChange: true,
                store: true
            }, next);
        }
    },  (err) => callback(err));
});

worker.apiMethod('disableWorker', {
    description:
        'Disable the specified process. This command will stop the process. ' +
        'Disabled status is stored persistently. So if the process is ' +
        'disabled, it will not start automatically on every boot.',
    input: {
        name: {
            description: 'Name of the worker',
            type: 'string',
            required: true
        }
    },
    output: schemaUtils.common.nullOutput,
    locks: ['procman']
}, function(args, callback) {
    procman.workers.with(args.name, (worker, next) => {
        worker.disable({
            cause: __('Disabled by API call'),
            disableDependent: true,
            logChange: true,
            store: true,
        }, next);
    },  (err) => callback(err));
});

worker.apiMethod('restartWorker', {
    description: 'Restart running process. This method is only applicable ' +
                 'for running processes.',
    input: {
        name: {
            description: 'Name of the worker',
            type: 'string',
            required: true
        }
    },
    output: schemaUtils.common.nullOutput,
    locks: ['procman']
}, function(args, callback) {
    procman.workers.with(args.name, (worker, next) => {
        worker.restart({
            cause: 'Restarted by API call',
            logChange: true
        }, next);
    },  (err) => callback(err));
});

worker.apiMethod('clearWorker', {
    description:
        'Clear cooldown of the specified process and start delayed process ' +
        'immediately. Cooldown is a special state of a worker. If a process ' +
        'restarts too fast procman will stop restarting the process and ' +
        'give the process some time to cool down and then start it again.',
    input: {
        name: {
            description: 'Name of the worker',
            type: 'string',
            required: true
        }
    },
    output: schemaUtils.common.nullOutput,
    locks: ['procman']
}, function(args, callback) {
    procman.workers.with(args.name, (worker, next) => {
        worker.clear({}, next);
    }, (err) => callback(err));
});

worker.apiMethod('enableDebug', {
    description:
        'Launch debugger for the specified worker. This method allows to ' +
        'inspect the specified worker internals and debug it during NEF ' +
        'runtime. Heartbeat checks are disabled for the worker.',
    input: {
        name: {
            description: 'Name of the worker',
            type: 'string',
            required: true
        },
        pauseOnStart: {
            description: 'Pause worker for debugging on first line',
            type: 'boolean',
            required: false,
            default: false
        }
    },
    output: schemaUtils.common.nullOutput,
    locks: ['procman']
}, function(args, callback) {
    procman.workers.with(args.name, (worker, next) => {
        worker.enableDebug({
            pauseOnStart: args.pauseOnStart,
            logChange: true,
            store: true,
        }, next);
    }, (err) => callback(err));
});

worker.apiMethod('disableDebug', {
    description:
        'Terminate debugger for the specified worker that has been started ' +
        'with the API method debugEnable. Hearbeat checks are enabled again.',
    input: {
        name: {
            description: 'Name of the worker',
            type: 'string',
            required: true
        }
    },
    output: schemaUtils.common.nullOutput,
    locks: ['procman']
}, function(args, callback) {
    procman.workers.with(args.name, (worker, next) => {
        worker.disableDebug({
            logChange: true,
            store: true,
        }, next);
    }, (err) => callback(err));
});

worker.apiMethod('enableHeartbeat', {
    description: 'Enable heartbeat check for the specified worker.',
    input: {
        name: {
            description: 'Name of the worker',
            type: 'string',
            required: true
        }
    },
    output: schemaUtils.common.nullOutput,
    locks: ['procman']
}, function(args, callback) {
    procman.workers.with(args.name, (worker, next) => {
        worker.enableHeartbeat({
            logChange: true,
            store: true,
        }, next);
    }, (err) => callback(err));
});

worker.apiMethod('disableHeartbeat', {
    description: 'Disable heartbeat check for the specified worker.',
    input: {
        name: {
            description: 'Name of the worker',
            type: 'string',
            required: true
        }
    },
    output: schemaUtils.common.nullOutput,
    locks: ['procman']
}, function(args, callback) {
    procman.workers.with(args.name, (worker, next) => {
        worker.disableHeartbeat({
            logChange: true,
            store: true,
        }, next);
    }, (err) => callback(err));
});

worker.apiMethod('getStatus', {
    description: 'Get status of NEF whole service',
    input: schemaUtils.common.nullInput,
    output: {
        type: 'object',
        properties: {
            state: {
                description: 'state of NEF service',
                type: 'string',
                enum: ['online', 'starting', 'stopping'],
            },
            pid: {
                description: 'PID of the main procman process',
                type: 'integer'
            }
        },
        additionalProperties: false,
    }
}, function(args, callback) {
    callback(undefined, procman.getStatus());
});

worker.apiMethod('rescheduleGuards', {
    description: 'Change guards schedule timer',
    input: {
        interval: {
            description: 'Interval in milliseconds',
            type: 'integer',
        }
    },
    output: schemaUtils.common.nullOutput,
}, function(args, done) {
    procman.memleakGuard.reschedule(args.interval, (err) => done(err));
});
