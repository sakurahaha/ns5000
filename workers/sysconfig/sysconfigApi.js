/**
 * @fileOverview ZMQ API of sysconfig worker.
 */

var assert    = require('assert');
var async     = require('async');
var Finder    = require('nef/finder');
var events    = require('nef/events');
var worker    = require('nef/baseWorker');
var nefUtils  = require('nef/utils');
var NefError  = require('nef/error').NefError;
var logger    = require('nef/logger');
var interop   = require('nef/interop');
var WorkerAdapter = require('nef/sysconfig/workerAdapter');
var schemas       = require('nef/schemas/sysconfig');
var schemaUtils   = require('nef/schemaUtils');
var Context = require('nef/sysconfig/Context');
var fs = require('fs');
var path = require('path');
var certificateSchema = require('nef/schemas/certificate');
var sslUtils = require('nef/sslUtils');
var execFile = require('child_process').execFile;
var main = require('./sysconfigMain');

/**
 * How many parallel precesses to use in properties discover
 */
var config = nefUtils.requireConfig('config/sysconfig');
DISCOVER_JOBS = config['discoverJobs'];

/**
 * Typical callback after a property is modified to handle emitting of
 * reboot needed event.
 */
function handleUpdateResult(ctx, callback, err) {
    if (ctx.global.rebootNeeded) {
        nefUtils.debounce('rebootNeeded', main.emitRebootNeededEvent, 1000);
    }

    callback(err, {
        rebootNeeded: ctx.global.rebootNeeded
    });
}

events.declare('NEF_sysconfig_set_param', {
    description: 'Parameter has been updated',
    range: 'joint',
    payload: {
        type: 'object'
    }
});

events.declare('NEF_sysconfig_apply_param', {
    description: 'Parameter has been applied to the system',
    range: 'joint',
    payload: {
        type: 'object'
    }
});

events.declare('NEF_sysconfig_load_param', {
    description: 'Parameter has been stored in database',
    range: 'joint',
    payload: {
        type: 'object'
    }
});

events.declare('NEF_sysconfig_keep_param', {
    description: 'Parameter has been cached',
    range: 'joint',
    payload: {
        type: 'object'
    }
});

events.declare('NEF_sysconfig_initialized', {
    description: 'Sysconfig worker started and finished initialization',
    range: 'private',
    payload: {
        type: 'object'
    }
});

events.declare('NEF_sysconfig_rebootNeeded', {
    description: 'Sysconfig has modified properties that requires reboot ' +
                  'to be applied',
    range: 'joint',
    payload: {
        type: 'object',
    },
});

events.declare('NEF_sysconfig_worker_connected', {
    description: 'Sysconfig has established connection to worker',
    range: 'private',
    payload: {
        type: 'object',
    },
});

events.declare('NEF_sysconfig_patternsCertificatesUpdated', {
    description: 'Sysconfig has updated patterns certificates',
    range: 'private',
    payload: {
        type: 'object',
    },
});

events.declare('NEF_sysconfig_workerCertificateUpdated', {
    description: 'Sysconfig has updated pattern certificate',
    range: 'private',
    payload: {
        type: 'object',
    },
});

function updatePatternsCertificatesOnEvent(event, pattern) {
    updatePatternsCertificates([pattern], function(err) {
        if (err) {
            logger.error(__('Update certificates with ALL and %s patterns ' +
                            'on event %s: %s', pattern, event, err.toString()));

            return;
        }
        logger.info(__('Update certificates with ALL and %s patterns on ' +
                       'event: %s', pattern, event));
        events.privateEvent('NEF_sysconfig_patternsCertificatesUpdated');
    });
}

function subscribeToEvents() {
    events.private.on('NEF_procman_process_online', function(data) {
        if (data == 'network') {
            events.private.on('NEF_network_object_created', function(data) {
                updatePatternsCertificatesOnEvent('NEF_network_object_created',
                                                  '%ALL_IPS%');
            });

            events.private.on('NEF_network_config_changed', function(data) {
                updatePatternsCertificatesOnEvent('NEF_network_config_changed',
                                                  '%ALL_IPS%');
            });

            events.private.on('NEF_network_object_destroyed', function(data) {
                updatePatternsCertificatesOnEvent(
                    'NEF_network_object_destroyed',
                    '%ALL_IPS%'
                );
            });
        }
    });

    var listen = [
        'unix.hostName',
        'unix.domainName'
    ];

    events.private.on('NEF_sysconfig_set_param', function(data) {
        if (listen.indexOf(data.id) !== -1) {
            const event = 'NEF_sysconfig_set_param (' + data.id + ')';
            updatePatternsCertificatesOnEvent(event, '%ALL_DNS%');
        }
    });
}

subscribeToEvents();

var moduleFinder = new Finder({
    scheme: schemas.module.properties,
    getAll: function(context, done) {
        var result = [];
        var modules = main.lookupModule();

        for (var id in modules) {
            result.push(modules[id].toJson());
        }
        done(undefined, result);
    }
});
moduleFinder.apiMethod(worker, 'findModules');

var paramFinder = new Finder({
    scheme: schemas.property.properties,
    input: {
        includeValues: {
            description: 'Include current and stored values into the result',
            type: 'boolean'
        },
        includeCurrentValues: {
            description: 'Include current values only',
            type: 'boolean'
        },
        includeStoredValues: {
            description: 'Include stored values only',
            type: 'boolean'
        },
        secure: schemas.input.secure,
        apiVersion: schemas.input.apiVersion,
        where: {
            type: 'object',
            properties: {
                anythingMatches: {
                    type: 'string',
                    description: 'Matches the specified pattern in id or ' +
                                 'description fields'
                }
            }
        }
    },
    getAll: function(context, done) {
        var res;
        var where = context.where || {};

        res = main.matchProperty({
            anythingMatches: where.anythingMatches,
            apiVersion: context.apiVersion,
        });
        delete where.anythingMatches;

        done(undefined, res);
    },

    beforeFind: function(context, result, done) {

        // Add currentValue and storedValue to the fields, if needed
        if (context.fields && context.fields.length > 0) {
            if (context.fields.indexOf('currentValue') == -1 &&
                (context.includeValues || context.includeCurrentValues)) {
                context.fields.push('currentValue');
            }

            if (context.fields.indexOf('storedValue') == -1 &&
                (context.includeValues || context.includeStoredValues)) {
                context.fields.push('storedValue');
            }

        }
        done();
    },

    // Hook to include values if asked
    afterPaginate: function(context, result, done) {
        var ctx = new Context({
            type: 'bulkGet',
        });

        // Quick quit if no values should be added
        if (!context.includeValues &&
            !context.includeCurrentValues &&
            !context.includeStoredValues) {
            return done();
        }

        async.forEachLimit(result, DISCOVER_JOBS, function(el, next) {
            var prop = main.lookupProperty({
                id: el.id,
                apiVersion: context.apiVersion,
            });
            async.parallel([
                function getCurrent(cb) {
                    if (!context.includeValues &&
                        !context.includeCurrentValues) {
                        return cb();
                    }

                    prop.get({
                        ctx: ctx,
                        persistent: false,
                        strict: false,
                        secure: context.secure
                    }, function(err, res) {
                        if (!err) {
                            el.currentValue = res;
                        }
                        process.nextTick(cb);
                    });
                },
                function getStored(cb) {
                    if (!context.includeValues &&
                        !context.includeStoredValues) {
                        return cb();
                    }

                    prop.get({
                        ctx: ctx,
                        persistent: true,
                        strict: true,
                        secure: context.secure
                    }, function(err, res) {
                        if (!err) {
                            el.storedValue = res;
                        }
                        process.nextTick(cb);
                    });
                },
            ], next);
        }, done);
    },
});
paramFinder.apiMethod(worker, 'findProperties');

worker.apiMethod('getProperty', {
    input: {
        id: schemas.id,
        module: schemas.moduleName,
        name: schemas.propertyName,
        publicName: schemas.publicName,
        apiVersion: schemas.input.apiVersion,
        persistent: schemas.input.persistent,
        strict: schemas.input.strict,
        secure: schemas.input.secure,
    },
    output: schemas.value,
}, function(args, callback) {
    var prop = main.lookupProperty(args);

    prop.get({
        ctx: new Context({type: 'get'}),
        persistent: args.persistent,
        strict: args.strict,
        secure: args.secure,
    }, callback);
});

/**
 * Set the value of the specified property of the specified configuration
 * module.
 *
 * @param {String}   [id]                Id of the property
 * @param {String}   [module]            Name of the module (if 'id' is not
 *                                       specified)
 * @param {String}   [name]              Name of the property (if 'id' is not
 *                                       specified)
 * @param {*}        value               Desired value
 * @param {Boolean}  [persistent=true]   Persistent store value of the specified
 *                                       property of the specified configuration
 *                                       module.
 */
worker.apiMethod('setProperty', {
    input: {
        id: schemas.id,
        module: schemas.moduleName,
        name: schemas.propertyName,
        publicName: schemas.publicName,
        apiVersion: schemas.input.apiVersion,
        persistent: schemas.input.persistent,
        strict:  schemas.input.strict,
        context: schemas.input.context,
        force: schemas.input.force,
        value: schemas.value
    },
    output: schemas.output.genericModify,
}, function(args, callback) {
    var ctx = new Context({
        type: 'set',
        name: args.context,
        args: {
            force: args.force
        }
    });

    main.setProperty(ctx, args, handleUpdateResult.bind(this, ctx, callback));
});

worker.apiMethod('bulkSetProperties', {
    description: 'Function to change couple of properties at once',
    input: {
        pairs: {
            description: 'Dict with pairs "id" => "value"',
            type: 'object',
            require: true,
        },
        apiVersion: schemas.input.apiVersion,
        persistent: schemas.input.persistent,
        strict:  schemas.input.strict,
        context: schemas.input.context,
        force: schemas.input.force
    },
    output: schemas.output.genericModify,
}, function(args, callback) {
    var ctx = new Context({
        type: 'bulkSet',
        name: args.context,
        args: {
            force: args.force
        }
    });

    async.forEachSeries(Object.keys(args.pairs), function(id, next) {
        main.setProperty(ctx, {
            id: id,
            value: args.pairs[id],
            persistent: args.persistent,
            strict: args.strict,
        }, next);
    }, handleUpdateResult.bind(this, ctx, callback));
});

/**
 * Reset temporary value of the property to persistent variant
 *
 * @param {String}   [id]                Id of the property
 * @param {String}   [module]            Name of the module (if 'id' is not
 *                                       specified)
 * @param {String}   [name]              Name of the property (if 'id' is not
 *                                       specified)
 */
worker.apiMethod('resetProperty', {
    input: {
        id: schemas.id,
        module: schemas.moduleName,
        name: schemas.propertyName,
        publicName: schemas.publicName,
        apiVersion: schemas.input.apiVersion,
        context: schemas.input.context,
        force: schemas.input.force,
        resetRebootNeeded: {
            description: 'Reset rebootNeeded flag instead of value',
            type: 'boolean'
        }
    },
    output: schemas.output.genericModify,
}, function(args, callback) {
    var prop = main.lookupProperty(args);
    var ctx = new Context({
        type: 'set',
        name: args.context,
        args: {
            force: args.force
        }
    });

    if (args.resetRebootNeeded) {
        prop.rebootNeeded = undefined;
        prop.store(callback);
        return;
    }

    prop.reset({
        ctx: ctx
    }, handleUpdateResult.bind(this, ctx, callback));
});

/**
 * Inserts array or object element into the property. It works only for arrays
 * and objects.
 *
 * If keyName is specified, the operation returns EEXIST if an entry with the
 * same key already exists.
 *
 * @param {String}   [id]                Id of the property
 * @param {String}   [module]            Name of the module (if 'id' is not
 *                                       specified)
 * @param {String}   [name]              Name of the property (if 'id' is not
 *                                       specified)
 * @param {Integer}  [index]             Index in array, where to insert element
 * @param {String}   [key]               Key in object for new value
 * @param {*}        value               Desired value (it's part of object)
 * @param {Boolean}  [persistent=true]   Persistent store value of the specified
 *                                       property of the specified configuration
 *                                       module.
 */
worker.apiMethod('insertIntoProperty', {
    input: {
        id: schemas.id,
        module: schemas.moduleName,
        name: schemas.propertyName,
        publicName: schemas.publicName,
        apiVersion: schemas.input.apiVersion,
        persistent: schemas.input.persistent,
        strict:  schemas.input.strict,
        context: schemas.input.context,
        force: schemas.input.force,
        value: schemas.value,
        index: schemas.input.index,
        key: schemas.input.key,
        keyName: schemas.input.keyName
    },
    output: schemas.output.genericModify,
}, function(args, callback) {
    var prop = main.lookupProperty(args);
    var ctx = new Context({
        type: 'set',
        name: args.context,
        args: {
            force: args.force
        }
    });

    prop.insertElement({
        ctx: ctx,
        persistent: args.persistent,
        strict: args.strict,
        addr: nefUtils.sliceObject(args, 'index', 'key', 'keyName'),
        element: args.value
    }, handleUpdateResult.bind(this, ctx, callback));
});

/**
 * Replace element in the property. It works only for arrays and objects
 *
 * @param {String}   [id]                Id of the property
 * @param {String}   [module]            Name of the module (if 'id' is not
 *                                       specified)
 * @param {String}   [name]              Name of the property (if 'id' is not
 *                                       specified)
 * @param {Integer}  [index]             Index in array for element that should
 *                                       be replaced
 * @param {String}   key                 Key in object for new value
 * @param {*}        value               Desired value (it's part of object)
 * @param {Boolean}  [persistent=true]   Persistent store value of the specified
 *                                       property of the specified configuration
 *                                       module.
 */
worker.apiMethod('replaceInProperty', {
    input: {
        id: schemas.id,
        module: schemas.moduleName,
        name: schemas.propertyName,
        publicName: schemas.publicName,
        apiVersion: schemas.input.apiVersion,
        persistent: schemas.input.persistent,
        strict:  schemas.input.strict,
        insertIfNotExists: schemas.input.insertIfNotExists,
        context: schemas.input.context,
        force: schemas.input.force,
        value: schemas.value,
        index: schemas.input.index,
        key: schemas.input.key,
        keyName: schemas.input.keyName
    },
    output: schemas.output.genericModify,
}, function(args, callback) {
    var prop = main.lookupProperty(args);
    var ctx = new Context({
        type: 'set',
        name: args.context,
        args: {
            force: args.force
        }
    });

    prop.replaceElement({
        ctx: ctx,
        persistent: args.persistent,
        strict: args.strict,
        insertIfNotExists: args.insertIfNotExists,
        addr: nefUtils.sliceObject(args, 'index', 'key', 'keyName'),
        element: args.value
    }, handleUpdateResult.bind(this, ctx, callback));
});

/**
 * Delete element from the property. It works only for arrays and objects
 *
 * @param {String}   [id]                Id of the property
 * @param {String}   [module]            Name of the module (if 'id' is not
 *                                       specified)
 * @param {String}   [name]              Name of the property (if 'id' is not
 *                                       specified)
 * @param {Integer}  [index]             Index in array for element that should
 *                                       be deleted
 * @param {String}   key                 Key in object which should be deleted
 * @param {Boolean}  [persistent=true]   Persistent store value of the specified
 *                                       property of the specified configuration
 *                                       module.
 */
worker.apiMethod('deleteFromProperty', {
    input: {
        id: schemas.id,
        module: schemas.moduleName,
        name: schemas.propertyName,
        publicName: schemas.publicName,
        apiVersion: schemas.input.apiVersion,
        persistent: schemas.input.persistent,
        strict:  schemas.input.strict,
        context: schemas.input.context,
        force: schemas.input.force,
        index: schemas.input.index,
        key: schemas.input.key,
        keyName: schemas.input.keyName
    },
    output: schemas.output.genericModify,
}, function(args, callback) {
    var prop = main.lookupProperty(args);
    var ctx = new Context({
        type: 'set',
        name: args.context,
        args: {
            force: args.force
        }
    });

    prop.deleteElement({
        ctx: ctx,
        persistent: args.persistent,
        strict: args.strict,
        addr: nefUtils.sliceObject(args, 'index', 'key', 'keyName')
    }, handleUpdateResult.bind(this, ctx, callback));
});

/*
 * Import/export configuration methods.
 */

/**
 * Export system configuration as a string.
 */
worker.apiMethod('exportConfiguration', {
    input: {
        includeMetaInfo: {
            description: 'Include meta information in to the configuration',
            type: 'boolean',
            default: false
        },
        where: paramFinder.inputScheme().where,
        secure: schemas.input.secure
    },
    output: {
        description: 'Whole system configuration in JSON format',
        type: 'string'
    }
}, function(args, callback) {
    var filter = undefined;

    async.waterfall([
        function filterParams(next) {
            if (!args.where) {
                return next();
            }

            var list = paramFinder.find({
                where: args.where,
                fields: ['id']
            }, function(err, res) {
                if (err) {
                    return next(err);
                }
                filter = nefUtils.pluck(res, 'id');
                next();
            });
        },
        function(next) {
            main.doExport({
                includeMetaInfo: args.includeMetaInfo,
                filter: filter,
                secure: args.secure
            }, next);
        }
    ], callback);
});

worker.apiMethod('importConfiguration', {
    input: {
        configuration: {
            decription: 'Whole or part of configuration as JSON string',
            type: 'string',
        },
        type: {
            description: 'Import task type: restore or clone',
            type: 'string',
            enum: ['clone', 'restore'],
        },
        force: schemas.input.force,
        overwriteMetaInfo: {
            description: 'Overwrite metaInfo with data from configuration',
            type: 'boolean',
            default: false
        },
        context: schemas.input.context
    },
    output: schemaUtils.common.nullOutput,
}, function(args, callback) {
    try {
        args.configuration = JSON.parse(args.configuration);
    } catch (e) {
        callback(NefError('EINVAL', __('Invalid JSON configuration: %s',
                e.toString())));
        return;
    }
    main.doImport(args);
    callback();
});

/**
 * Returns import job status overview.
 */
worker.apiMethod('getJobStatus', {
    input: schemaUtils.common.nullInput,
    output: {
        type: 'object',
        properties: {
            status: {
                description: 'Keyword with status of the job',
                type: 'string',
                enum: ['none', 'initializing', 'unknown', 'failed',
                       'aborted', 'done', 'running'],

            },
            finished: {
                description: 'True if job is finished',
                type: 'boolean',
            },
            description: {
                description: 'Job status description',
                type: 'l10nString'
            },
            error: {
                description: 'Error object if status is failed',
                type: 'object',
            },
            rebootNeeded: schemas.output.rebootNeeded,
            tasks: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        module: {
                            description: 'Name of the module to import, ' +
                                         'or milestone name',
                            type: 'string'
                        },
                        status: {
                            description: 'Status of the import task',
                            type: 'string',
                            enum: ['unknown', 'queued', 'pending', 'running',
                                    'failed', 'done', 'aborted', 'passed'],
                        },
                        finished: {
                            description: 'True if task job is finished',
                            type: 'boolean',
                        },
                        description: {
                            description: 'Task status description',
                            type: 'l10nString'
                        },
                        groupIndex: {
                            description: 'Index of this task in the order',
                            type: 'integer',
                        },
                        type: {
                            description: 'Type of the task',
                            type: 'string',
                            enum: ['milestone', 'task'],
                        },
                        error: {
                            description: 'Error object if status is failed',
                            type: 'object',
                        }
                    },
                    additionalProperties: false,
                },
            },
        },
        additionalProperties: false,
    },
}, function(args, callback) {
    var job = main.getImportJob();

    if (!job) {
        return callback(undefined, {
            status: 'none',
            tasks: [],
        });
    }

    callback(undefined, job.getStatus());
});

/**
 * Stops import job. Note that it just prevents next step from being executed.
 * It won't interrupt hanging step.
 */
worker.apiMethod('abortJob', {
    input: schemaUtils.common.nullInput,
    output: schemaUtils.common.nullOutput,
}, function(args, done) {
    var job = main.getImportJob();

    if (!job) {
        done(NefError('ENOENT',
                __('There is no active or completed import job')));
        return;
    }
    job.abort(done);
});

/*
 * Appliance profile methods.
 */

/*
 * Show list of profiles
 * @returns array of hashs  [{name: 'file name1'}, {name: 'file name2'}];
 */
var profileFinder = new Finder({
    scheme: schemas.profile.properties,
    getAll: function(context, done) {
        var profProp = main.lookupProperty('profile.applianceProfile');
        var ctx = new Context({type: 'get'});
        var active;

        // get currently active profile
        profProp.get({
            ctx: ctx,
            persistent: true,
            strict: true,
        }, function(err, res) {
            if (err) {
                return done(err);
            }
            active = res;

            // get list of profiles
            var profs = main.lookupProfile();
            var res = [];

            for (var p in profs) {
                res.push({
                    name: p,
                    description: profs[p].description,
                    active: (p === active)
                });
            }
            done(undefined, res);
        });
    }
});
profileFinder.apiMethod(worker, 'findProfiles');

/*
 * Apply profile - apply settings from it to the system.
 */
worker.apiMethod('applyProfile', {
    description: 'Apply settings from profile to the system',
    input: {
        name: schemas.profile.properties.name,
        context: schemas.input.context,
        force: schemas.input.force
    },
    output: schemaUtils.common.nullOutput
}, function(args, callback) {
    var prof = main.lookupProfile(args.name);

    main.doImport({
        configuration: prof,
        type: 'applyProfile',
        force: args.force
    });

    main.waitingForImport(callback);
});

/*
 * Service methods.
 */

worker.apiMethod('enableService', {
    description: 'Restart selected service',
    input: {name: schemas.serviceName},
    output: schemaUtils.common.nullOutput
}, function(args, done) {
    var svc = main.lookupService(args.name);
    var ctx = new Context({
        type: 'set',
    });

    if (!svc.enabler) {
        throw new NefError('ENOSYS', __('Service %s cannot be enabled or ' +
                'disabled', args.name));
    }

    main.setProperty(ctx, {
        id: svc.enabler,
        persistent: true,
        strict: true,
        value: true
    }, done);
});

worker.apiMethod('disableService', {
    description: 'Restart selected service',
    input: {name: schemas.serviceName},
    output: schemaUtils.common.nullOutput
}, function(args, done) {
    var svc = main.lookupService(args.name);
    var ctx = new Context({
        type: 'set',
    });

    if (!svc.enabler) {
        throw new NefError('ENOSYS', __('Service %s cannot be enabled or ' +
                'disabled', args.name));
    }

    main.setProperty(ctx, {
        id: svc.enabler,
        persistent: true,
        strict: true,
        value: false
    }, done);
});

worker.apiMethod('restartService', {
    description: 'Restart selected service',
    input: {name: schemas.serviceName},
    output: schemaUtils.common.nullOutput
}, function(args, done) {
    var svc = main.lookupService(args.name);
    svc.restart(done);
});

worker.apiMethod('refreshService', {
    description: 'Re-read service configuration',
    input: {name: schemas.serviceName},
    output: schemaUtils.common.nullOutput
}, function(args, done) {
    var svc = main.lookupService(args.name);
    svc.refresh(done);
});

worker.apiMethod('clearService', {
    description: 'Clear maintenance state for service',
    input: {name: schemas.serviceName},
    output: schemaUtils.common.nullOutput
}, function(args, done) {
    var svc = main.lookupService(args.name);
    svc.clear(done);
});

worker.apiMethod('getServiceProperties', {
    description: 'Get properties with values of the service',
    input: {
        name: schemas.serviceName,
        metaInfo: schemas.propertyMetaInfo,
        secure: schemas.input.secure
    },
    output: schemas.servicePropertiesWithMetaInfo
}, function(args, done) {
    var svc = main.lookupService(args.name);
    var result = {};
    var ctx = new Context({
        type: 'bulkGet'
    });

    if (args.metaInfo) {
        result.metaInfo = {};
    }

    async.each(Object.keys(svc.properties), function(name, next) {
        var id = svc.properties[name];
        var prop;

        try {
            prop = main.lookupProperty(id);
        } catch (e) {
            // XXX could be that underlaying module got unloaded?
            logger.warn(__('Skip service property %s: %s',
                        id, e.toString()));
            return next();
        }

        prop.get({
            ctx: ctx,
            persistent: true,
            strict: true,
            secure: args.secure
        }, function(err, res) {
            if (err) {
                return next(err);
            }
            result[name] = res;
            if (args.metaInfo) {
                result.metaInfo[name] = prop.toJson('brief');
            }
            next();
        });
    }, function(err) {
        if (err) {
            done(err);
        } else {
            done(undefined, result);
        }
    });
});

worker.apiMethod('setServiceProperties', {
    description: 'Set service properties',
    input: {
        name: schemas.serviceName,
        properties: schemas.serviceProperties,
        force: schemas.input.force
    },
    output: schemaUtils.common.nullOutput
}, function(args, done) {
    var svc = main.lookupService(args.name);
    var setProps = {};
    var ctx = new Context({
        type: 'bulkSet'
    });

    // translate from service to module name
    for (var name in args.properties) {
        var id = svc.properties[name];

        if (id === undefined) {
            throw new NefError('EBADARG', __('Unknown service property %s',
                    name));
        }
        setProps[id] = args.properties[name];
    }

    async.each(Object.keys(setProps), function(id, next) {
        main.setProperty(ctx, {
            id: id,
            persistent: true,
            strict: true,
            value: setProps[id]
        }, next);
    }, done);
});

var serviceFinder = new Finder({
    scheme: schemas.service.properties,
    getAll: function(context, done) {
        var services = main.lookupService();
        var key = context.where && context.where.name;

        // optimisation hack: skip obtaining service state for services which
        // are not wanted.
        if (key) {
            var newServices = {};
            if (services[key]) {
                newServices[key] = services[key];
            }
            services = newServices;
        }
        async.mapLimit(Object.keys(services), DISCOVER_JOBS,
            function(name, next) {
            var svc = services[name];

            svc.getState(function(err, state) {
                if (err) {
                    state = 'unknown';
                    logger.error(__('Unable to obtain state of service %s: %s',
                            svc.name, err.toString()));
                }
                next(undefined, {
                    name: svc.name,
                    description: svc.description,
                    state: state,
                    type: svc.type,
                });
            });
        }, done);
    }
});
serviceFinder.apiMethod(worker, 'findServices');

/**
 * Hidden sysconfig-worker connection API method.
 */
worker.apiMethod('workerCommand', {
    input: {
        worker: {
            type: 'string',
        },
        command: {
            type: 'string',
        },
        arguments: {
            type: 'object',
        },
    },
    output: {
        type: 'any'
    },
    private: true
}, function(args, callback) {
    var moduleId = 'worker.' + args.worker;
    var module = main.lookupModule(moduleId);

    async.waterfall([
        function createIfNeeded(next) {
            if (module !== undefined) {
                return next();
            }

            if (args.command !== 'initConnection') {
                return next(NefError('ENOENT',
                            __('No module %s found, register it first',
                            moduleId)));
            }
            module = new WorkerAdapter({
                worker: worker,
                id: moduleId,
                workerName: args.worker
            });
            main.installModule(module, next);
        },

        function handleCommand(next) {
            var methodName = 'handle' + nefUtils.capitalize(args.command);
            if (module[methodName] === undefined) {
                return next(NefError('EBADARG',
                            __('Command "%s" is not supported',
                            args.command)));
            }

            try {
                module[methodName](args.arguments, next);
            } catch (e) {
                return next(NefError('EINVAL',
                            __('Exception in workerCommand: %s',
                            e.toString())));
            }
        }
    ], callback);
});

/**
 * SSL Certificates API methods.
 */
var caFinder = new Finder({
    scheme: certificateSchema.sslObject.properties,
    getAll: function(ctx, callback) {
        sslUtils.listCas(callback);
    }
});
caFinder.apiMethod(worker, 'findCertificateAuthorities');

var requestFinder = new Finder({
    scheme: certificateSchema.sslObject.properties,
    getAll: function(ctx, callback) {
        sslUtils.listRequests(callback);
    }
});
requestFinder.apiMethod(worker, 'findRequests');

var certificateFinder = new Finder({
    scheme: certificateSchema.sslObject.properties,
    getAll: function(ctx, callback) {
        sslUtils.listCertificates(callback);
    }
});
certificateFinder.apiMethod(worker, 'findCertificates');

function createPassFile(passphrasePath, pp, done) {
    if (!pp) {
        return done();
    }
    fs.writeFile(passphrasePath, pp, done);
}

function deletePassFile(extErr, passphrasePath, done) {
    fs.stat(passphrasePath, function(err) {
        if (err) {
            return done(extErr);
        }

        fs.unlink(passphrasePath, (err) => {
            if (err) {
                logger.error(__('Failed to unlink passfile: %s',
                                err.toString()));
            }
            return done(extErr);
        });
    });
}

function getAltNameParts(altName) {
    const items = altName.split(',');
    const dns = [];
    const ips = [];

    items.forEach(item => {
        const parts = item.split(':');
        const type = parts[0].toLowerCase();
        const value = parts[1];
        if (value) {
            if (type === 'dns') {
                dns.push(value);
            } else if (type === 'ip') {
                ips.push(value);
            }
        }
    });

    return {dns, ips};
}

function createAltNamesFile(altPath, altName, done) {
    if (!altName) {
        return done();
    }

    const p = getAltNameParts(altName);
    const dns = p.dns;
    const ips = p.ips;

    const result = ['[ v3_req ]', 'basicConstraints = CA:FALSE',
        'keyUsage = nonRepudiation, digitalSignature, keyEncipherment',
        'subjectAltName = @alt_names', '', '[ alt_names ]'];

    for (let i = 0; i < dns.length; i++) {
        const s = 'DNS.' + (i + 1) + ' = ' + dns[i];
        result.push(s);
    }

    for (let i = 0; i < ips.length; i++) {
        const s = 'IP.' + (i + 1) + ' = ' + ips[i];
        result.push(s);
    }
    fs.writeFile(altPath, result.join('\n'), done);
}

function deleteTmpFiles(altPath, passphrasePath, extErr, done) {
    fs.stat(altPath, function(err) {
        if (err) {
            return deletePassFile(extErr, passphrasePath, done);
        }
        fs.unlink(altPath, (err) => {
            if (err) {
                logger.error(__('Failed to unlink altnames file: %s',
                                err.toString()));
            }
            return deletePassFile(extErr, passphrasePath, done);
        });
    });
}

worker.apiMethod('createSslCertificateAuthority', {
    description: 'Create local SSL Certificate Authority',
    restType: 'POST',
    input: certificateSchema.createCaInput,
    output: schemaUtils.common.nullOutput
}, function(args, callback) {
    var name = args.name;
    var pp = args.passphrase;
    var subject = args.subject;
    var days = args.days;

    var keyPath = sslUtils.getObjectPath('key', name);
    var caPath = sslUtils.getObjectPath('ca', name);

    var passphrasePath = '/tmp/pp';
    var passphraseOption = 'file:' + passphrasePath;

    async.series([
        (next) => {
            caFinder.find({
                where: {
                    name: name
                }
            }, function(err, data) {
                if (err) {
                    next(err);
                    return;
                }

                if (data.length > 0) {
                    next(NefError('EEXIST', __('Certificate authority %s ' +
                                               'exists', name)));
                    return;
                }

                next();
            });
        },
        (next) => createPassFile(passphrasePath, pp, next),
        (next) => {
            const options = ['genrsa'];

            if (pp) {
                options.push('-des3');
                options.push('-passout');
                options.push(passphraseOption);
            }

            options.push('-out');
            options.push(keyPath);
            options.push(sslUtils.BITS);

            execFile(sslUtils.OPENSSL, options, function(err) {
                if (err) {
                    logger.error(__('Failed to generate certificate ' +
                                    'authority root key: %s', err.toString()));
                    next(NefError('EFAILED', __('Failed to generate ' +
                                  'certificate authority root key')));
                    return;
                }

                next();
            });
        },
        (next) => {
            const options = ['req', '-x509', '-new', '-subj', subject];

            if (pp) {
                options.push('-passin');
                options.push(passphraseOption);
            }

            options.push('-key');
            options.push(keyPath);
            options.push('-days');
            options.push(days);
            options.push('-out');
            options.push(caPath);

            execFile(sslUtils.OPENSSL, options, function(err) {
                if (err) {
                    logger.error(__('Failed to generate certificate ' +
                                    'authority certificate: %s',
                                    err.toString()));
                    next(NefError('EFAILED', __('Failed to generate ' +
                                  'certificate authority certificate')));
                    return;
                }

                next();
            });
        },
        (next) => fs.chmod(keyPath, 0o400, next),
    ], (err) => deletePassFile(err, passphrasePath, callback));
});

worker.apiMethod('installSslCertificateAuthority', {
    description: 'Install remote SSL Certificate Authority certificate',
    restType: 'POST',
    input: certificateSchema.installCaInput,
    output: schemaUtils.common.nullOutput
}, function(args, callback) {
    var caName = args.name;
    var caBody = args.pemContents;

    var caPath = sslUtils.getObjectPath('ca', caName);

    async.series([
        (next) => {
            caFinder.find({
                where: {
                    name: caName
                }
            }, function(err, data) {
                if (err) {
                    next(err);
                    return;
                }

                if (data.length > 0) {
                    next(NefError('EEXIST', __('Certificate authority %s ' +
                                               'exists', caName)));
                    return;
                }

                next();
            });
        },
        (next) => {
            var stdout;
            var ossl = execFile(sslUtils.OPENSSL, ['x509']);
            ossl.stdin.write(caBody);
            ossl.stdin.end();

            ossl.stdout.on('data', function(data) {
                stdout = data;
            });

            ossl.on('close', function(err) {
                if (err) {
                    logger.error(__('Failed to install certificate ' +
                                    'authority: %s', stdout));
                    return next(NefError('EINVAL', __('Failed to install ' +
                        'certificate authority')));
                }

                next();
            });
        },
        (next) => fs.writeFile(caPath, caBody, next),
    ], (err) => callback(err));
});

worker.apiMethod('destroySslCertificateAuthority', {
    description: 'Remove SSL Certificate Authority certificate',
    restType: 'POST',
    input: {
        name: {
            description: 'Certificate authority name',
            type: 'string',
            required: true
        }
    },
    output: schemaUtils.common.nullOutput
}, function(args, callback) {
    var caName = args.name;

    caFinder.find({where: {name: caName}}, function(err, res) {
        if (err) {
            callback(err);
            return;
        }

        if (res.length == 0) {
            callback(NefError('ENOENT', __('Certificate authority \'%s\' ' +
                'does not exist', caName)));
            return;
        }

        fs.unlink(res[0].path, callback);
    });
});

worker.apiMethod('generateSslSigningRequest', {
    description: 'Generates SSL client certificate signing request',
    restType: 'POST',
    input: certificateSchema.createCsrInput,
    output: schemaUtils.common.nullOutput
}, function(args, callback) {
    var pp = args.passphrase;
    var subject = args.subject;
    var name = args.name;
    var keyPath = sslUtils.getObjectPath('key', name);
    var requestPath = sslUtils.getObjectPath('request', name);

    var passphrasePath = '/tmp/pp';
    var passphraseOption = 'file:' + passphrasePath;

    async.series([
        (next) => requestFinder.find({
            where: {
                name: name
            }}, function(err, data) {

            if (err) {
                next(err);
                return;
            }

            if (data.length > 0) {
                next(NefError('EEXIST', __('Certificate signing request ' +
                    '\'%s\' exists', name)));
                return;
            }

            next();
        }),
        (next) => createPassFile(passphrasePath, pp, next),
        (next) => {
            const options = ['req', '-newkey', sslUtils.RSA_BITS];

            if (pp) {
                options.push('-passout');
                options.push(passphraseOption);
            } else {
                options.push('-nodes');
            }

            options.push('-subj');
            options.push(subject);
            options.push('-keyout');
            options.push(keyPath);
            options.push('-out');
            options.push(requestPath);

            execFile(sslUtils.OPENSSL, options, function(err) {
                if (err) {
                    logger.error(__('Failed to generate certificate request:' +
                                    ' %s', err.toString()));
                    next(NefError('EFAILED', __('Failed to generate ' +
                                            'certificate signing request')));
                    return;
                }

                next();
            });
        },
        (next) => fs.chmod(keyPath, 0o400, next),
    ],
    (err) => deletePassFile(err, passphrasePath, callback));
});

worker.apiMethod('destroySslSigningRequest', {
    description: 'Remove SSL client certificate signing request',
    restType: 'POST',
    input: {
        name: {
            description: 'Certificate authority name',
            type: 'string',
            required: true
        },
    },
    output: schemaUtils.common.nullOutput
}, function(args, callback) {
    var csrName = args.name;

    requestFinder.find({where: {name: csrName}}, function(err, res) {
        if (err) {
            callback(err);
            return;
        }

        if (res.length == 0) {
            callback(NefError('ENOENT', __('Certificate signing request ' +
                '\'%s\' does not exist', csrName)));
            return;
        }

        fs.unlink(res[0].path, callback);
    });
});

worker.apiMethod('signSslSigningRequest', {
    description: 'Sign SSL client certificate signing request with the local' +
                 ' certificate authority',
    restType: 'POST',
    input: certificateSchema.signCertificateInput,
    output: schemaUtils.common.nullOutput
}, function(args, callback) {
    var name = args.name;
    var caName = args.caName;
    var altName = args.altName;

    var pp = args.passphrase;
    var days = args.days;

    var csrPath;
    var caPath;
    var caKeyPath = sslUtils.getObjectPath('key', caName);
    var certPath =  sslUtils.getObjectPath('certificate', name);

    var passphrasePath = '/tmp/pp';
    var passphraseOption = 'file:' + passphrasePath;
    var altPath = '/tmp/alt';

    async.series([
        (next) => certificateFinder.find({where: {name: name}},
            function(err, res) {
            if (err) {
                return next(err);
            }

            if (res.length > 0) {
                next(NefError('EEXIST', __('Certificate \'%s\' exists',
                    name)));
                return;
            }

            next();
        }),
        (next) => requestFinder.find({where: {name: name}},
            function(err, res) {
            if (err) {
                return next(err);
            }

            if (res.length == 0) {
                next(NefError('ENOENT', __('Certificate request \'%s\' does ' +
                    'not exist', name)));
                return;
            }

            csrPath = res[0].path;

            next();
        }),
        (next) => caFinder.find({where: {name: caName}}, function(err, res) {
            if (err) {
                return next(err);
            }

            if (res.length == 0) {
                next(NefError('ENOENT', __('Certificate authority \'%s\' ' +
                    'does not exist', caName)));
                return;
            }

            caPath = res[0].path;

            next();
        }),
        (next) => createPassFile(passphrasePath, pp, next),
        (next) => createAltNamesFile(altPath, altName, next),
        (next) => {
            const options = ['x509', '-req'];

            if (altName) {
                options.push('-extfile');
                options.push(altPath);
                options.push('-extensions');
                options.push('v3_req');
            }

            options.push('-in');
            options.push(csrPath);
            options.push('-CA');
            options.push(caPath);
            options.push('-CAkey');
            options.push(caKeyPath);
            options.push('-CAcreateserial');

            if (pp) {
                options.push('-passin');
                options.push(passphraseOption);
            }

            options.push('-days');
            options.push(days);
            options.push('-out');
            options.push(certPath);

            execFile(sslUtils.OPENSSL, options, function(err) {
                if (err) {
                    logger.error(__('Failed to sign certificate: %s',
                        err.toString()));
                    next(NefError('EFAILED', __('Failed to sign certificate')));
                    return;
                }

                next();
            });
        },
    ], (err) => deleteTmpFiles(altPath, passphrasePath, err, callback));
});

worker.apiMethod('installSslSignedCertificate', {
    description: 'Uploads signed certificate based on generated certificate ' +
                 'request',
    restType: 'POST',
    input: certificateSchema.installCertificateInput,
    output: schemaUtils.common.nullOutput
}, function(args, callback) {
    var name = args.name;
    var caName = args.caName;
    var cert = args.certificatePem;
    var caPath;
    var certPath =  sslUtils.getObjectPath('certificate', name);

    async.series([
        (next) => certificateFinder.find({where: {name: name}},
            function(err, res) {
            if (err) {
                return next(err);
            }

            if (res.length > 0) {
                next(NefError('EEXIST', __('Certificate \'%s\' exists', name)));
                return;
            }

            next();
        }),
        (next) => requestFinder.find({where: {name: name}},
            function(err, res) {
            if (err) {
                return next(err);
            }

            if (res.length == 0) {
                next(NefError('ENOENT', __('Certificate request \'%s\' does ' +
                    'not exist', name)));
                return;
            }

            next();
        }),
        (next) => caFinder.find({where: {name: caName}}, function(err, res) {
            if (err) {
                return next(err);
            }

            if (res.length == 0) {
                next(NefError('ENOENT', __('Certificate authority \'%s\' ' +
                    'does not exist', caName)));
                return;
            }

            caPath = res[0].path;

            next();
        }),
        (next) => {
            var stdout;
            var sslProc = execFile(sslUtils.OPENSSL, ['verify', '-CAfile',
                                   caPath, '-purpose', 'sslclient']);

            sslProc.stdin.write(cert);
            sslProc.stdin.end();

            sslProc.stdout.on('data', function(data) {
                stdout = data;
            });

            sslProc.on('close', function(err) {
                if (err) {
                    logger.error(__('Failed to verify certificate: %s',
                        stdout));
                    return next(NefError('EFAILED', __('Failed to verify ' +
                        'signed certificate against chosen certificate ' +
                        'authority')));
                }
                next();
            });
        },
        (next) => fs.writeFile(certPath, cert, next)
    ], (err) => {
            if (err) {
                return callback(err);
            }
            callback(undefined);
        }
    );
});

function destroyCsr(certName, done) {
    requestFinder.find({where: {name: certName}}, function(err, res) {
        if (err) {
            done(err);
            return;
        }

        if (res.length == 0) {
            done();
            return;
        }

        fs.unlink(res[0].path, done);
    });
}

worker.apiMethod('destroySslCertificate', {
    description: 'Remove SSL Certificate',
    restType: 'POST',
    input: {
        name: {
            description: 'Certificate authority name',
            type: 'string',
            required: true
        },
    },
    output: schemaUtils.common.nullOutput
}, function(args, callback) {
    var certName = args.name;
    var certPath;
    var keyPath;
    var optionsPath = sslUtils.SSL_OPTIONS_PATH + '/' + certName;

    async.series([
        // check that certificate exists
        (next) => {
            certificateFinder.find({where: {name: certName}},
                function(err, res) {
                if (err) {
                    next(err);
                    return;
                }

                if (res.length == 0) {
                    next(NefError('ENOENT', __('Certificate \'%s\' does not ' +
                        'exist', certName)));
                    return;
                }

                certPath = res[0].path;
                keyPath = sslUtils.getObjectPath('key', certName);

                next();
            });
        },

        // destroy certificate
        (next) => fs.unlink(certPath, next),

        // destroy Certificate Signing Request (if exists)
        (next) => destroyCsr(certName, next),

        // destroy key
        (next) => fs.unlink(keyPath, next),

        // destroy options file (if exists)
        (next) => fs.unlink(optionsPath, err => { next(); }),

    ], (err) => callback(err));
});

function getAllNames(done) {
    if (process.platform === 'linux') {
        // Doesn't work on linux - no network worker
        // and unix.hostDomainName prop
        return done(NefError('EFAILED', __('ALL pattern is not supported' +
                                           ' on linux')));
    }

    async.parallel([
        (next) => getAllDns(next),
        (next) => getAllIps(next),
    ], (err, res) => {
        if (err) {
            return done(err);
        }
        done(undefined, res.join(','));
    });
}

function getAllIps(done) {
    if (process.platform === 'linux') {
        // Doesn't work on linux - no network worker
        return done(NefError('EFAILED', __('ALL_IPS pattern is not supported' +
                                           ' on linux')));
    }

    interop.call('network', 'findAddresses', {}, function(err, res) {
        if (err) {
            return done(err);
        }

        if (res && res.length) {
            var result = [];
            res.forEach(item => {
                if (item.interface !== 'lo0' && item.protocol !== 'ipv6') {
                    result.push('ip:' + item.address);
                }
            });
            return done(undefined, result.join(','));
        }

        done(NefError('ENOENT', __('No IP addresses found')));
    });
}

function getAllDns(done) {
    if (process.platform === 'linux') {
        // Doesn't work on linux - no unix.hostDomainName prop
        return done(NefError('EFAILED', __('ALL_DNS pattern is not supported' +
                                           ' on linux')));
    }

    var prop = main.lookupProperty('unix.hostDomainName');
    prop.get({
        ctx: new Context({type: 'get'}),
        persistent: false,
    }, (err, res) => {
        if (err) {
            return done(err);
        }
        done(undefined, 'dns:' + res);
    });
}

function resolvePatterns(name, altName, done) {
    if (!altName || !altName.includes('%')) {
        return done(undefined, altName);
    }

    var result = [];
    var items = altName.split(',');
    async.each(items, (item, next) => {
        switch (item) {
            case '%ALL%':
                getAllNames(function(err, res) {
                    if (err) {
                        logger.error(__('Failed to resolve ALL pattern: %s',
                                       err.message));
                        return next();
                    }
                    result.push(res);
                    next();
                });
                break;
            case '%ALL_IPS%':
                getAllIps(function(err, res) {
                    if (err) {
                        logger.error(__('Failed to resolve ALL_IPS pattern: %s',
                                       err.message));
                        return next();
                    }
                    result.push(res);
                    next();
                });
                break;
            case '%ALL_DNS%':
                getAllDns(function(err, res) {
                    if (err) {
                        logger.error(__('Failed to resolve ALL_DNS pattern: %s',
                                       err.message));
                        return next();
                    }
                    result.push(res);
                    next();
                });
                break;
            default:
                result.push(item);
                next();
        }
    }, (err) => {
        if (err) {
            logger.error(__('Failed to resolve pattern: %s', err.message));
            return done(undefined, '');
        }

        const str = result.join(',');
        const arr = str.split(',');
        const obj = {};
        for (let i = 0; i < arr.length; i++) {
            const res = arr[i];
            obj[res] = true;
        }

        done(undefined, Object.keys(obj).join(','));
    });
}

worker.apiMethod('getOrCreateCertificate', {
    description: 'Get Worker SSL Certificate file paths',
    restType: 'POST',
    input: certificateSchema.getOrCreateCertificateInput,
    output: certificateSchema.getOrCreateCertificateOutput
}, function(args, callback) {
    var certName = args.name;
    var caName = args.caName || sslUtils.LOCAL_CA_NAME;
    var subject = args.subject || sslUtils.WORKER_CERT_SUBJECT_PART + certName;
    var days = args.days || sslUtils.WORKER_CERT_DAYS;
    var altName = '';
    var passphrase = args.passphrase;
    var autogenerate = args.autogenerate;
    var saveOptions = false;

    async.waterfall([
        // resolve subject alternative names patterns
        (next) => resolvePatterns(certName, args.altName, next),

        // set altName
        (res, next) => {
            altName = res;
            next();
        },

        // find certificate
        (next) => certificateFinder.find({where: {name: certName}}, next),

        // create certificate if reqired
        (res, next) => {
            const opt = {
                certName,
                caName,
                subject,
                days,
                altName,
                passphrase
            };

            if (res.length === 0) {
                if (!autogenerate) {
                    next(NefError('ENOENT', __('Certificate \'%s\' does not ' +
                                               'exist', certName)));
                    return;
                }
                saveOptions = true;
                createWorkerCertificate(opt, next);
                return;
            }

            const cert = res[0];
            const certPath = cert.path;
            const keyPath = sslUtils.getObjectPath('key', certName);

            if (sameSubject(cert, subject) && sameAltName(cert, altName)) {

                const result = {
                    certificatePath: certPath,
                    privateKeyPath: keyPath
                };

                next(undefined, result);
                return;
            }

            if (autogenerate) {
                saveOptions = true;
                regenerateCertificate(certPath, keyPath, certName, opt, next);
                return;
            }

            next(NefError('ENOENT', __('Unable to re-generate certificate ' +
                                       '\'%s\' with updated options: ' +
                                       'autogenerate disabled', certName)));
        },

        // save request options for certificate regenaration
        (result, next) => {
            if (!saveOptions) {
                next(undefined, result);
                return;
            }

            if (passphrase) {
                // password protected certificates not regenerated for security
                // reasons: in order not to store a password
                next(undefined, result);
                return;
            }

            const str = JSON.stringify({certName, caName, subject, days,
                                        altName: args.altName});
            const name = sslUtils.SSL_OPTIONS_PATH + '/' + certName;

            fs.writeFile(name, str, function(err) {
                if (err) {
                    logger.error(__('Failed to save certificate request ' +
                                    'options: %s', err.toString()));
                }
                next(undefined, result);
            });
        },
    ], callback);
});

function regenerateCertificate(certPath, keyPath, certName, opt, done) {

    logger.warn(__('Removing worker certificate %s to re-create', certName));

    async.series([
        // destroy certificate
        (next) => {
            fs.unlink(certPath, function(err) {
                if (err) {
                    logger.warn(__('Failed to remove worker certificate %s ' +
                                'to re-create: %s', certName, err.toString()));
                }
                next();
            });
        },

        // destroy Certificate Signing Request (if exists)
        (next) => destroyCsr(certName, next),

        // destroy key
        (next) => {
            fs.unlink(keyPath, function(err) {
                if (err) {
                    logger.warn(__('Failed to remove certificate key ' +
                                    'for worker certificate %s: %s', certName,
                                    err.toString()));
                }
                next();
            });
        },

    ], (err) => {
        if (err) {
            return done(err);
        }

        createWorkerCertificate(opt, function(err, res) {
            if (err) {
                return done(err);
            }

            events.privateEvent('NEF_sysconfig_workerCertificateUpdated', {
                certName: certName,
                opt: opt
            });

            done(undefined, res);
        });
    });
}

function updatePatternsCertificates(patterns, done) {
    var optionsPath = sslUtils.SSL_OPTIONS_PATH;
    fs.readdir(optionsPath, function(err, items) {
        if (err) {
            return done(err);
        }

        var asyncList = [];
        items.forEach(function(name) {
            asyncList.push(next => {
                fs.readFile(path.join(optionsPath, name), function(err, data) {
                    if (err) {
                        logger.error(__('Failed to update certificate %s: %s',
                                        name, err.toString()));
                        next();
                        return;
                    }
                    processCertOptionsFile(patterns, name, data,
                                           function(err, data) {
                        if (err) {
                            logger.error(__('Failed to update certificate ' +
                                            '%s: %s', name, err.toString()));
                        }
                        next();
                    });
                });
            });
        });

        async.series(asyncList, done);
    });
}

function processCertOptionsFile(patterns, name, data, done) {
    var json;
    try {
        json = JSON.parse(data.toString());
    } catch (e) {
        logger.error(__('Failed to update certificate %s: incorrect JSON',
                        name));
        done();
        return;
    }

    const altName = json.altName;
    if (!altName || !altName.includes('%')) {
        done();
        return;
    }

    var items = altName.split(',');
    if (items.includes('%ALL%')) {
        updatePatternCertificate(name, json, done);
        return;
    }

    for (let i = 0; i < patterns.length; i++) {
        const pattern = patterns[i];
        if (items.includes(pattern)) {
            updatePatternCertificate(name, json, done);
            return;
        }
    }

    done();
}

function updatePatternCertificate(certName, json, done) {
    var altName = '';
    async.waterfall([
        // resolve subject alternative names patterns
        (next) => resolvePatterns(certName, json.altName, next),

        // set altName
        (res, next) => {
            altName = res;
            next();
        },

        // re-create certificate
        (next) => {
            const certPath = sslUtils.getObjectPath('certificate', certName);
            const keyPath = sslUtils.getObjectPath('key', certName);
            const opt = {
                certName,
                caName: json.caName,
                subject: json.subject,
                days: json.days,
                altName,
            };
            regenerateCertificate(certPath, keyPath, certName, opt, next);
        },
    ], done);
}

function sameSubject(cert, subject) {
    const s = '/' + cert.subject;
    const a1 = s.replace(/\s/g, '').split('/');
    const a2 = subject.replace(/\s/g, '').split('/');

    if (a1.sort().join() === a2.sort().join()) {
        return true;
    }

    logger.warn(__('Certificate subject updated: %s', subject));
    return false;
}

function newListItem(list, items) {
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!list.includes(item)) {
            logger.warn(__('Found new Certificate Subject Alternative Name ' +
                           'record: %s', item));
            return true;
        }
    }
    return false;
}

function sameAltName(cert, altName) {
    if (cert.altName && altName) {
        // compare alt names
        const certItems = cert.altName.split(',');
        const optItems = altName.split(',');
        const certDns = [];
        const certIps = [];
        certItems.forEach(item => {
            const p = item.split(':');
            const key = p[0].trim();
            if (key === 'DNS') {
                certDns.push(p[1]);
            } else if (key === 'IP Address') {
                certIps.push(p[1]);
            }
        });

        const p = getAltNameParts(altName);

        const optDns = p.dns;
        const optIps = p.ips;
        if (newListItem(certDns, optDns) || newListItem(certIps, optIps)) {
            // added item - regenerate certificate
            return false;
        }

        // same alt names - keep certificate
        return true;
    }

    if (altName && !cert.altName) {
        // added alt names - regenerate certificate
        return false;
    }

    // keep certificate with alt names in case requested without them
    return true;
}

function createWorkerCertificate(opt, done) {
    var certName = opt.certName;
    var caName = opt.caName;
    var subject = opt.subject;
    var days = opt.days;
    var altName = opt.altName;
    var pp = opt.passphrase;
    var keyPath = sslUtils.getObjectPath('key', certName);
    var requestPath = sslUtils.getObjectPath('request', certName);

    var altPath = '/tmp/alt';
    var passphrasePath = '/tmp/pp';
    var passphraseOption = 'file:' + passphrasePath;

    var csrPath;
    var caPath;

    var caKeyPath = sslUtils.getObjectPath('key', caName);
    var certPath =  sslUtils.getObjectPath('certificate', certName);

    logger.info(__('Creating worker certificate %s', certName));

    async.series([
        (next) => createPassFile(passphrasePath, pp, next),
        (next) => {
            const options = ['req', '-newkey', sslUtils.RSA_BITS];

            if (pp) {
                options.push('-passout');
                options.push(passphraseOption);
            } else {
                options.push('-nodes');
            }

            options.push('-subj');
            options.push(subject);
            options.push('-keyout');
            options.push(keyPath);
            options.push('-out');
            options.push(requestPath);

            execFile(sslUtils.OPENSSL, options, function(err) {
                if (err) {
                    logger.error(__('Failed to generate certificate request:' +
                                    ' %s', err.toString()));
                    next(NefError('EFAILED', __('Failed to generate ' +
                                            'certificate signing request')));
                    return;
                }

                next();
            });
        },
        (next) => fs.chmod(keyPath, 0o400, next),
        (next) => requestFinder.find({where: {name: certName}},
            function(err, res) {
            if (err) {
                return next(err);
            }

            if (res.length == 0) {
                next(NefError('ENOENT', __('Certificate request \'%s\' does ' +
                    'not exist', certName)));
                return;
            }

            csrPath = res[0].path;

            next();
        }),
        (next) => caFinder.find({where: {name: caName}}, function(err, res) {
            if (err) {
                return next(err);
            }

            if (res.length == 0) {
                next(NefError('ENOENT', __('Certificate authority \'%s\' ' +
                    'does not exist', caName)));
                return;
            }

            caPath = res[0].path;
            next();
        }),
        (next) => createPassFile(passphrasePath, pp, next),
        (next) => createAltNamesFile(altPath, altName, next),
        (next) => {
            const options = ['x509', '-req'];

            if (altName) {
                options.push('-extfile');
                options.push(altPath);
                options.push('-extensions');
                options.push('v3_req');
            }

            options.push('-in');
            options.push(csrPath);
            options.push('-CA');
            options.push(caPath);
            options.push('-CAkey');
            options.push(caKeyPath);
            options.push('-CAcreateserial');

            if (pp) {
                options.push('-passin');
                options.push(passphraseOption);
            }

            options.push('-days');
            options.push(days);
            options.push('-out');
            options.push(certPath);

            execFile(sslUtils.OPENSSL, options, function(err) {
                if (err) {
                    logger.error(__('Failed to sign certificate: %s',
                        err.toString()));
                    next(NefError('EFAILED', __('Failed to sign certificate')));
                    return;
                }

                next();
            });
        },
    ], (err) => {
            if (err) {
                return deleteTmpFiles(altPath, passphrasePath, err, done);
            }

            deleteTmpFiles(altPath, passphrasePath, undefined, function(err) {
                if (err) {
                    return done(err);
                }

                const result = {
                    certificatePath: sslUtils.getObjectPath('certificate',
                                                            certName),
                    privateKeyPath: sslUtils.getObjectPath('key', certName)
                };

                done(undefined, result);
            });
        });
}
