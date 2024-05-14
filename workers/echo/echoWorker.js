#!/usr/bin/env node

/**
 * @fileOverview Echo worker
 * Copyright (C) 2012, 2013  Nexenta Systems, Inc.
 * All rights reserved.
 */

var worker = require('nef/baseWorker');
var NefError = require('nef/error').NefError;
var events = require('nef/events');
var logger = require('nef/logger');
var http = require('http');
var async = require('async');
var Finder = require('nef/finder');
var schemaUtils = require('nef/schemaUtils');
var nefUtils = require('nef/utils');


//
// Fake binding library because of https://jira.nexenta.com/browse/NEX-20248
//
try {
    var libecho = require('nef/echo');
} catch (e) {
    var libecho = {
        asyncEcho(time, msg, done) {
            setTimeout(_ => {done(undefined, msg)}, time);
        },

        syncEcho(time, msg, done) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, time);
            done(undefined, msg);
        }
    }
}

var commonConfig = nefUtils.requireConfig('config/common');

worker.info(require('./worker.json'));

var Client = require('nef/client');

/**
 * Return same string as received synchronously
 *
 * @param {String}  str  Client string
 *
 * @returns {String}  Copied string back to client
 *
 * @public
 */
worker.apiMethod('echoSync', {
    description:
        'Return the same string as received or if not provided default ' +
        'string "echoOk" synchronously.',
    restType: 'GET',
    input: {
        str: {
            description: 'Client string',
            type: 'string',
            default: 'echoOk'
        }
    },
    output: {
        description:
            'Copied string back to client or string "echoOk" if client ' +
            'string was not provided',
        type: 'string',
        required: true
    }
}, function(args, callback) {
    callback(undefined, args.str);
});

/**
 * Return same string as received right after EIO is completed in 500 ms
 * Delay duration can be overriden with args.delay argument
 *
 * @param {String}      str     Client string
 * @param {Integer}     [delay] Delay in ms
 *
 * @returns {String}    Copied string back to client
 */
worker.apiMethod('echoAsync', {
    description:
        'Return same string as received after timeout. ' +
        'Delay duration can be overriden with delay argument.',
    restType: 'GET',
    input: {
        str: {
            description: 'Client string',
            type: 'string',
            required: true
        },
        delay: {
            description: 'Delay in ms',
            type: 'integer',
            default: 500
        }
    },
    output: {
        description: 'Copied string back to client',
        type: 'string',
        required: true
    }
}, function(args, callback) {
    // starts the task ...
    setTimeout(function() {
        callback(undefined, args.str);
    }, args.delay);
});

/**
 * Return same string as received right after cross worker call
 *
 * @param {String}      str     Client string
 *
 * @returns {String}    Copied string back to client
 *
 * @public
 */
worker.apiMethod('echoCrossAsync', {
    description:
        'Return same string as received right after cross worker call.',
    restType: 'GET',
    input: {
        str: {
            description: 'Client string',
            type: 'string',
            required: true
        }
    },
    output: {
        description: 'Copied string back to client',
        type: 'string',
        required: true
    }
}, function(args, callback) {
    var client = new Client('1.0', 'tcp://127.0.0.1:5557');
    client.worker('logger', function(err, logger) {
        if (err) {
            callback(err);
            return;
        }
        if (logger.desc.name === undefined) {
            callback(NefError('GETWORKER-ERROR',
                    __('Cannot access MDP result')));
            return;
        }
        callback(undefined, args.str);
    });
});

var failureRestartActivated = false;
worker.apiMethod('echoFailure', {
    description: 'Return string or fail worker with given type of failure',
    resultType: 'GET',
    input: {
        str: {
            description: 'String to return',
            type: 'string',
            default: 'echoOk'
        },
        failureType: {
            description: 'Type of failure: none, unexpectedException, ' +
                         'forgetAnswer, restart, freeze, ' +
                         'setFlag, restartOnFlag, freezeOnFlag',
            type: 'string',
            default: 'none',
            enum: [
                'none',
                'unexpectedException',
                'forgetAnswer',
                'restart',
                'freeze',
                'restartOnFlag',
                'setFlag',
                'freezeOnFlag',
                'bindingError',
                'normalError'
            ]
        },
        returnCode: {
            description: 'Return code for restart process procedure',
            type: 'integer',
            default: 200
        }
    },
    output: {
    }
}, function(args, done) {
    switch (args.failureType) {
        case 'none':
            done(undefined, args.str);
            break;
        case 'unexpectedException':
            logger.info('Emulate unexpectedException');
            process.nextTick(() => {
                undefined.toString();
            });
            break;
        case 'normalError':
            done(NefError('EFAILED', 'Expected failure'));
            break;
        case 'bindingError':
            libecho.asyncEcho(500, 'argument_failure', done);
            break;
        case 'forgetAnswer':
            logger.info('Emulate error when worker forget to answer');
            break;
        case 'restart':
            logger.info('Emulate worker restart');
            process.exit(args.returnCode);
            break;
        case 'freeze':
            logger.info('Emulate worker freeze');
            libecho.syncEcho(100000000, args.str, () => {});
            break;
        case 'setFlag':
            logger.info('Set freeze/restart flag to true');
            failureRestartActivated = true;
            done(undefined, args.str);
            break;
        case 'restartOnFlag':
            logger.info(__('Emulate worker restart on flag (flag = %s)',
                            failureRestartActivated));
            if (failureRestartActivated) {
                process.exit(args.returnCode);
            }
            done(undefined, args.str);
            break;
        case 'freezeOnFlag':
            logger.info(__('Emulate worker freeze on flag (flag = %s)',
                            failureRestartActivated));

            if (failureRestartActivated) {
                libecho.syncEcho(100000000, args.str, () => {});
            } else {
                done(undefined, args.str);
            }
            break;
        default:
            done(NefError('EBADARG', __('Unknown failure type: %s',
                args.failureType)));
            break;
    }
});

/**
 * Return same string as received right after native EIO is completed in 1 sec
 *
 * @param {String}      str     Client string
 *
 * @returns {String}    Copied string back to client
 *
 * @public
 */
worker.apiMethod('echoAsyncNative', {
    description:
        'Return same string as received right after native async call is ' +
        'completed (in 1 sec).',
    restType: 'GET',
    input: {
        str: {
            description: 'Client string',
            type: 'string',
            required: true
        }
    },
    output: {
        description: 'Copied string back to client',
        type: 'string',
        required: true
    }
}, function(args, callback) {
    // starts native EIO ...
    libecho.asyncEcho(500, args.str, callback);
});

/**
 * Return same string as received native synchronously
 *
 * @param {String}      str     Client string
 *
 * @returns {String}    Copied string back to client
 *
 * @public
 */
worker.apiMethod('echoSyncNative', {
    description:
        'Return same string as received right after native sync call is ' +
        'completed (in 1 sec).',
    restType: 'GET',
    input: {
        str: {
            description: 'Client string',
            type: 'string',
            required: true
        }
    },
    output: {
        description: 'Copied string back to client',
        type: 'string',
        required: true
    }
}, function(args, callback) {
    libecho.syncEcho(500, args.str, callback);
});

/**
 * Return same string as received and do not log anything so that it can be
 * used for benchmarking
 *
 * @param {String}      str     Client string
 *
 * @returns {String}    Copied string back to client
 *
 * @public
 */
worker.apiMethod('echoBenchmarkSync', {
    description:
        'Return same string as received and do not log anything so that ' +
        'it can be used for benchmarking.',
    restType: 'GET',
    input: {
        str: {
            description: 'Client string',
            type: 'string',
            required: true
        }
    },
    output: {
        description: 'Copied string back to client',
        type: 'string',
        required: true
    }
}, function(args, callback) {
    callback(undefined, args.str);
});

/**
 * Return garbage string
 *
 * @returns {String}    Garbage string back to client
 *
 * @public
 */
worker.apiMethod('returnInvalidOutput', {
    description:
        'Return a garbage back to client. Used for testing of invalid ' +
        'output from server.',
    restType: 'GET',
    input: {
        returnSomething: {
            description: 'Return garbage if true',
            type: 'boolean',
            default: true
        }
    },
    output: {
        description: 'Returns number 42 or nothing instead of a string',
        type: 'string',
        required: true
    }
}, function(args, callback) {
    callback(undefined, (args.returnSomething) ? 42 : undefined);
});

/**
 * Return same string as received delaying response with the given time.
 * This method is marked as being locked. Multiple requests to the
 * this method will be serialized
 *
 * @param {String}      str     Client string
 * @param {Integer}	[delay] Delay in ms
 *
 * @returns {String}    Same string back to client
 *
 * @public
 */
worker.apiMethod('echoLocking', {
    description:
        'Return same string as received delaying response with the given ' +
        'time. This method acquires "echo" lock. Multiple requests to ' +
        'this method will be serialized.',
    restType: 'GET',
    input: {
        str: {
            description: 'Client string',
            type: 'string',
            required: true
        },
        delay: {
            description: 'Delay in ms',
            type: 'integer',
            default: 500
        }
    },
    output: {
        description: 'Copied string back to client',
        type: 'string',
        required: true
    },
    locks: ['echo']
}, function(args, callback) {
    setTimeout(function() {
        callback(undefined, args.str);
    }, (args.delay === undefined) ? 500 : args.delay);
});

/**
 * echoLockingA
 *
 * @param {String}      str     Client string
 * @param {Integer}	[delay]
 *
 * @returns {String}    Same string back to client
 *
 * @public
 */
worker.apiMethod('echoLockingA', {
    description:
        'Return same string as received delaying response with the given ' +
        'time. This method acquires lock "A".',
    restType: 'GET',
    input: {
        str: {
            description: 'Client string',
            type: 'string',
            required: true
        },
        delay: {
            description: 'Delay in ms',
            type: 'integer',
            default: 500
        }
    },
    output: {
        description: 'Copied string back to client',
        type: 'string',
        required: true
    },
    locks: ['A']
}, function(args, callback) {
    setTimeout(function() {
        callback(undefined, args.str);
    }, args.delay);
});

/**
 * echoLockingB
 *
 * @param {String}      str     Client string
 * @param {Integer}	[delay]
 *
 * @returns {String}    Same string back to client
 *
 * @public
 */
worker.apiMethod('echoLockingB', {
    description:
        'Return same string as received delaying response with the given ' +
        'time. This method acquires lock "B".',
    restType: 'GET',
    input: {
        str: {
            description: 'Client string',
            type: 'string',
            required: true
        },
        delay: {
            description: 'Delay in ms',
            type: 'integer',
            default: 500
        }
    },
    output: {
        description: 'Copied string back to client',
        type: 'string',
        required: true
    },
    locks: ['B']
}, function(args, callback) {
    setTimeout(function() {
        callback(undefined, args.str);
    }, args.delay);
});

/**
 * echoLockingAB
 *
 * @param {String}      str     Client string
 * @param {Integer}	[delay]
 *
 * @returns {String}    Same string back to client
 *
 * @public
 */
worker.apiMethod('echoLockingAB', {
    description:
        'Return same string as received delaying response with the given ' +
        'time. This method acquires lock "A" and "B".',
    input: {
        str: {
            description: 'Client string',
            type: 'string',
            required: true
        },
        delay: {
            description: 'Delay in ms',
            type: 'integer',
            default: 500
        }
    },
    output: {
        description: 'Copied string back to client',
        type: 'string',
        required: true
    },
    locks: ['A', 'B']
}, function(args, callback) {
    setTimeout(function() {
        callback(undefined, args.str);
    }, args.delay);
});

/**
 * Return same string as received delaying response with the given time.
 * List of locks to acquire must be passed in args.locks argument
 *
 * @param {String}      str     Client string
 * @param {String[]}    locks
 * @param {Integer}	delay
 *
 * @returns {String}    Copied string back to client
 *
 * @public
 */
worker.apiMethod('echoExplicitLocking', {
    description:
        'Return same string as received delaying response with the given ' +
        'time. List of locks to acquire must be passed in locks argument.',
    restType: 'GET',
    input: {
        str: {
            description: 'Client string',
            type: 'string',
            required: true
        },
        locks: {
            description: 'Locks to acquire',
            type: 'array',
            items: {
                type: 'string',
                minItems: 1
            },
            required: true
        },
        delay: {
            description: 'Delay in ms',
            type: 'integer',
            default: 500
        }
    },
    output: {
        description: 'Copied string back to client',
        type: 'string',
        required: true
    }
}, function(args, callback) {
    worker.lockManager.lock(args.locks, function(free) {
        setTimeout(function() {
            free();
            callback(undefined, args.str);
        }, args.delay);
    });
});

/**
 * Return same string as received along with notifications received from async
 * native binding.
 *
 * @param {String}      str     Client string
 * @param {Integer}     delay   Entire operation duration in ms
 *
 * @returns {Array}     List of received strings with time offsets
 *
 * @public
 */
worker.apiMethod('echoAsyncWithNotifications', {
    description:
        'Return same string as received along with notifications received ' +
        'from async native binding.',
    restType: 'GET',
    input: {
        str: {
            description: 'Client string',
            type: 'string',
            required: true
        },
        delay: {
            description: 'Delay in ms',
            type: 'integer',
            required: true
        }
    },
    output: {
        type: 'array',
        description: 'List of received strings with time offsets',
        required: true,
        items: {
            type: 'object',
            minItems: 1,
            additionalProperties: false,
            properties: {
                str: {
                    description: 'String sent from native call',
                    type: 'string',
                    required: true
                },
                timeOffset: {
                    description: 'Time delta from start of the call in ms',
                    type: 'integer',
                    required: true
                }
            }
        }
    }
}, function(args, callback) {
    var result = [];
    var start = new Date();
    var sent = false;
    libecho.asyncEchoWithNotifications(args.delay, args.str, (err, res) => {
        if (err) {
            callback(err);
        } else {
            result.push({
                timeOffset: new Date() - start,
                str: res
            });
            if (res == args.str) {
                if (sent) {
                    return;
                }
                sent = true;
                callback(undefined, result);
            }
        }
    });
});

/**
 * Example how to use events
 */
events.declare('NEF_echo_echo', {
    description: 'Example event, emited on echoEvent API call',
    range: 'joint',
    payload: {
        type: 'object',
        properties: {
            str: {
                type: 'string'
            }
        }
    }
});

/**
 * Return same string via event mechanics
 *
 * @param {String}      str     Client string
 *
 * @public
 */
worker.apiMethod('echoEvent', {
    desription: 'Return same string via event mechanism.',
    restType: 'GET',
    input: {
        str: {
            description: 'Client string',
            type: 'string',
            required: true
        }
    },
    output: schemaUtils.common.nullOutput
}, function(args, callback) {
    events.jointEvent('NEF_echo_echo', {
        str: args.str
    });
    callback();
});

/**
 * Return the same string as received using different NEF binding methods.
 */
worker.apiMethod('testBindings', {
    input: {
        str: {
            description: 'Client string',
            type: 'string',
            required: true
        },
        method: {
            description: 'Binding method to use',
            type: 'string',
            enum: [
                'asyncJob',
                'asyncVoidFunc',
                'asyncReturnFunc',
                'syncCallbackFunc',
                'syncReturnFunc',
                'syncNanFunc'
            ],
            required: true
        }
    },
    output: {
        description: 'Copied string back to client',
        type: 'string',
        required: true
    }
}, function(args, done) {
    // 'syncReturnFunc' and 'syncNanFunc' don't use a callback to
    // return values.
    if (['syncReturnFunc', 'syncNanFunc'].indexOf(args.method) >= 0) {
        try {
            var s = libecho[args.method](args.str);
            done(undefined, s);
        } catch (e) {
            done(e);
        }
        return;
    }

    libecho[args.method](args.str, (err, res) => {
        if (err) {
            done(err);
            return;
        }

        if (args.method === 'asyncVoidFunc') {
            // 'asyncVoidFunc' is binding for a C++ void function,
            // that is, it does return any value.
            done(undefined, args.str);
        } else {
            done(undefined, res);
        }
    });
});

var _allocatedMem = [];
worker.apiMethod('eatMemory', {
    input: {
        amount: {
            description: 'Amount in something equal to millions ' +
                         'of unicode chars',
            type: 'integer',
            required: true
        },
    },
    output: schemaUtils.common.nullOutput
}, function(args, done) {
    _allocatedMem.push(Array(args.amount * 1000 * 1000).fill('allocated mem'));
    done();
});

worker.apiMethod('freeMemory', {
    input: schemaUtils.common.nullInput,
    output: schemaUtils.common.nullOutput
}, function(args, done) {
    _allocatedMem = [];
    done();
});

/*
 * Demo of the collection powered by Finder engine
 */
var finderSchema = {
    id: {
        description: 'ID of entry',
        type: 'string',
        required: true
    },
    name: {
        description: 'Person\'s name',
        type: 'string',
        required: true
    },
    height: {
        description: 'Person\'s height',
        type: 'integer',
        required: true
    },
    fruits: {
        description: 'Person\'s preference of fruit',
        type: 'array',
        required: true,
        items: {
            type: 'string'
        }
    }
};

var echoFinder = new Finder({
    scheme: finderSchema,
    getAll: [
        {id: 'item1', name: 'Jimmy', height: 164, fruits: ['apple', 'limon']},
        {id: 'item2', name: 'Linda', height: 166, fruits: ['tomate', 'lime']},
        {id: 'item3', name: 'Bob', height: 201, fruits: ['cherry', 'apple']},
        {id: 'item4', name: 'Walter', height: 185, fruits: ['peach', 'limon']},
        {id: 'item5', name: 'Donato', height: 174, fruits: ['limon', 'plum']},
        {id: 'item6', name: 'Lazar', height: 192, fruits:
            ['orange', 'cherry']},
        {id: 'item7', name: 'Warren', height: 172, fruits:
            ['peach', 'blackberry']},
        {id: 'item8', name: 'Vlad', height: 183, fruits: ['lime', 'pepper']},
        {id: 'item9', name: 'Ola', height: 92,
            fruits: ['strawberry', 'orange']},
    ]
});

echoFinder.apiMethod(worker);

worker.start();
