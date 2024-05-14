/**
 * JSON schemas used by procman.
 *
 * There are two object types: worker and workerProcess. Worker type
 * has only subset of workerProcess properties, since workerProcess
 * represents a running worker (thus it has all worker fields plus some
 * other describing the running instance of the worker).
 */

var utils       = require('nef/utils');
var schemaUtils = require('nef/schemaUtils');

var required    = schemaUtils.required;
var withDefault = schemaUtils.withDefault;

var schemas = {}; // exported stuff

// commonly used procman types
var types = {
    name: {
        description: 'Name of the worker',
        type: 'string'
    },
    path: {
        description: 'File in workers dir that should be used to start worker',
        type: 'string',
    },
    args: {
        description: 'Arguments of the command to start the worker',
        type: 'array',
        items: {
            description: 'command argument',
            type: 'string'
        }
    },
    enabled: {
        description:
            'Enable/disable state of the worker. It can be undefined in ' +
            'which case the state is overriden by configuration file.',
        type: 'boolean'
    },
    enabledCause: schemaUtils.l10nStringType({
        description: 'The cause why worker is enabled or disabled',
    }),
    status: {
        description: 'Current status of the worker',
        type: 'string'
    },
    statusDescription: schemaUtils.l10nStringType({
        description: 'Human readable description of the cause',
    }),
    require: {
        description: 'Worker names which this worker depends on',
        type: 'array',
        items: {
            description: 'Worker name',
            type: 'string'
        }
    },
    after: {
        description: 'All workers that should be started before this one',
        type: 'array',
        items: {
            description: 'Worker name',
            type: 'string'
        }
    },
    tags: {
        description: 'List of worker\'s tags',
        type: 'array',
        items: {
            description: 'Tag',
            type: 'string'
        }
    },
    debug: {
        description:
            'Process runs in debug mode with opened port for a debugger. ' +
            'Applicable only to node.js workers.',
        type: 'boolean'
    },
    pauseOnStart: {
        description: 'Stop worker for debugging just after start',
        type: 'boolean'
    },
    heartbeatDisabled: {
        description: 'Heartbeat checks are disabled',
        type: 'boolean'
    },
    pid: {
        description: 'PID of worker process',
        type: 'integer'
    },
    respawnId: {
        description: 'Counter incremented upon each worker process restart',
        type: 'integer'
    }
};

/*
 * JSON meta file. Similar to worker schema below except that all properties
 * are optional to allow user to override only those properties which are
 * needed and additional unspecified properties are allowed.
 */
schemas.workerMeta = {
    description: 'JSON stored in worker meta file',
    type: 'object',
    properties: {
        name: types.name,
        path: types.path,
        args: types.args
    }
};

/*
 * Information about worker persistently stored in database.
 */
schemas.workerStoredData = {
    description: 'Stored data for all workers',
    type: 'object',
    properties: {
        id: {
            description: 'ID of the worker',
            type: 'string',
            required: true
        },
        name: required(types.name),
        path: required(types.path),
        enabled: types.enabled,
        debug: types.debug,
        pauseOnStart: types.pauseOnStart,
        heartbeatDisabled: types.heartbeatDisabled
    },
    additionalProperties: false
};

/*
 * Basic worker above info for API
 */
schemas.worker = {
    description: 'Worker description and run time information',
    type: 'object',
    properties: {
        name: required(types.name),
        path: required(types.path),
        args: required(types.args),
        online: {
            description: 'Worker is connected to the broker',
            type: 'boolean',
            required: true
        },
        running: {
            description: 'Worker process is currently running',
            type: 'boolean',
            required: true
        },
        status: types.status,
        statusDescription: types.statusDescription,
        enabled: types.enabled,
        enabledCause: types.enabledCause,
        tags: types.tags,
        require: types.require,
        after: types.after,
        pid: types.pid,
        respawnId: types.respawnId,
        debug: types.debug,
        pauseOnStart: types.pauseOnStart,
        heartbeatDisabled: types.heartbeatDisabled,

        // Additional info for includeProcInfo: true
        cpu: {
            description: 'CPU usage of worker process',
            type: 'number',
            minimum: 0
        },
        memory: {
            description: 'Memory usage of worker process in bytes',
            type: 'integer',
            minimum: 0
        },

        // Additional info for includeStats: true
        stats: {
            description: 'Worker API calls statistics',
            type: 'object',
            properties: {
                requests: {
                    description: 'Total number of requests sent to the worker',
                    type: 'integer',
                },
                responses: {
                    description: 'Total number of responses received from ' +
                        'the worker',
                    type: 'integer',
                },
                protocolErrors: {
                    description: 'Numer of MDP protocol violations during ' +
                        'worker request processing',
                    type: 'integer',
                },
                connectedTimes: {
                    description: 'How many times broker established ' +
                                 'connection with the worker',
                    type: 'integer',
                },
                missedHeartbeats: {
                    description: 'Number of times when worker was slow in ' +
                                 'sending heartbeat',
                    type: 'integer',
                },
                failedHeartbeats: {
                    description: 'Number of times when count of missing ' +
                                 'heartbeats exceeded liveness limit',
                    type: 'integer',
                },
            }
        }
    },
    additionalProperties: false
};

schemas.workerStartEvent = {
    description: 'Worker process start information',
    type: 'object',
    properties: {
        name: required(types.name),
        path: required(types.path),
        args: required(types.args),
        debug: required(types.debug),
        heartbeatDisabled: required(types.heartbeatDisabled),
        pid: required(types.pid),
        respawnId: required(types.respawnId)
    }
};

schemas.workerStopEvent = {
    description: 'Worker process exit information',
    type: 'object',
    properties: {
        name: required(types.name),
        debug: required(types.debug),
        pid: required(types.pid),
        respawnId: required(types.respawnId),
        enabled: required(types.enabled),
        exitCode: {
            description: 'Exit code of worker process',
            type: 'integer',
            required: true
        },
        signal: {
            description: 'Signal sent by parent if the signal was ' +
                         'immediate root cause of the exit',
            type: 'string'
        }
    }
};

module.exports = schemas;
