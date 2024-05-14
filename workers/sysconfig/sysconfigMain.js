/**
 * Hearth of the sysconfig worker maintaining information
 * about modules and properties and providing methods for manipulating
 * them.
 */

var async     = require('async');
var assert    = require('assert');
var ImportJob = require('nef/sysconfig/importJob');
var nefUtils  = require('nef/utils');
var worker    = require('nef/baseWorker');
var logger    = require('nef/logger');
var events    = require('nef/events');
var NefError  = require('nef/error').NefError;
var Context   = require('nef/sysconfig/Context');
var commonConfig = nefUtils.requireConfig('config/common');

// exported stuff from this module
var main = {};

// We need this if we change GLOBAL config scheme
// DO NOT USE for separate modules changes, use local versions
var GLOBAL_CONFIG_VERSION = 1;
var importJobInstance = undefined;

/*
 * In-memory configuration storage
 */
var modules = {};
var props = {};
var propsByPublicName = {};
var services = {};
var profiles = {};
var rebootNeededTimer;

function cleanupModuleProperties(module) {
    for (var id in props) {
        if (props[id].module.id === module.id) {
            delete props[id];
        }
    }
}

function indexModuleProperties(module) {
    for (var i = 0; i < module.properties.length; i++) {
        var prop = module.properties[i];
        props[prop.id] = prop;

        publicName = prop.publicName;
        if (publicName) {
            propsByPublicName[publicName] = prop;
        }
    }
}

/**
 * Installs module into sysconfig worker, and registers all listeners
 */
main.installModule = function(module, done) {

    if (!module.enabled()) {
        logger.debug(__('Bypassing disabled module %s', module.id));
        return done();
    }

    assert(!modules[module.id], 'Double installation of sysconfig module ' +
            module.id);
    modules[module.id] = module;

    module.on('reinitialized', function(module) {
        cleanupModuleProperties(module);
        indexModuleProperties(module);
    });

    module.on('removed', function(module) {
        cleanupModuleProperties(module);
        delete modules[module.id];
    });

    module.init(function(err) {
        if (err) {
            return done(err);
        }

        indexModuleProperties(module);
        logger.debug(__('Installed module %s', module.id));
        done();
    });
};

/**
 * Install service into sysconfig worker.
 */
main.installService = function(svc) {

    if (!svc.enabled()) {
        logger.debug(__('Bypassing disabled service %s', svc.name));
        return;
    }

    function propSuffix(str) {
        var idx = str.indexOf('.');
        return str.slice(idx + 1);
    }

    assert(!services[svc.name], 'Double installation of service ' + svc.name);

    // expand enabler property name if it is relative
    if (svc.enabler && svc.enabler.indexOf('.') === -1) {
        if (typeof svc.properties !== 'string') {
            throw new NefError('EINVAL', __('Enabler property of service %s ' +
                    'cannot be specified by relative name if module name is ' +
                    'not known.'));
        }
        svc.enabler = svc.properties + '.' + svc.enabler;
    }

    // expand properties specified by module name
    if (typeof svc.properties === 'string') {
        var module = modules[svc.properties];
        var properties = {};

        if (module === undefined) {
            throw new NefError('EINVAL',
                    __('Module %s referenced in service %s was not found',
                        svc.properties, svc.name));
        }
        module.properties.forEach(function(p) {
            // enabled property is not a true service property
            if (p.id !== svc.enabler) {
                properties[propSuffix(p.id)] = p.id;
            }
        });
        svc.properties = properties;
    // strip prefixes of properties specified by sysconfig property IDs
    } else if (nefUtils.isArray(svc.properties)) {
        var properties = {};

        svc.properties.forEach(function(id) {
            if (props[id] === undefined) {
                throw new NefError('EINVAL',
                        __('Property %s referenced in service %s was not found',
                            id, svc.name));
            }
            properties[propSuffix(id)] = id;
        });
        svc.properties = properties;
    } else {
        assert.strictEqual(typeof svc.properties, 'object',
                'Invalid specification of properties for service ' + svc.name);
    }

    // we don't want l10n strings in API
    if (typeof svc.description !== 'string') {
        svc.description = svc.description.toString();
    }

    logger.debug(__('Installed service %s', svc.name));
    services[svc.name] = svc;
};

/**
 * Lookup module by its ID or return all modules if ID is unspecified.
 */
main.lookupModule = function(id) {
    if (!id) {
        return modules;
    } else {
        return modules[id];
    }
};

/**
 * Lookup service by name.
 * Throw exception if service cannot be found.
 */
main.lookupService = function(name) {

    if (!name) {
        return services;
    }

    var svc = services[name];

    if (!svc) {
        throw new NefError('ENOENT', __('Service %s not found', name));
    }
    return svc;
};

/**
 * Does lookup for one property with given id or module + name.
 * Throws exception with NefError object if property cannot be found.
 *
 * @param  {String}   args           args with location data
 * @return {Object}                  property object
 */
main.lookupProperty = function(args) {
    var prop;

    if (!nefUtils.isObject(args)) {
        args = {
            id: args
        };
    }

    if (args.id) {
        prop = props[args.id];
        if (!prop) {
            throw new NefError('ENOENT',
                        __('Failed to find property with id "%s"',
                            args.id));
        }
    } else if (args.module && args.name) {
        if (modules[args.module] === undefined) {
            throw new NefError('ENOENT',
                        __('Failed to find sysconfig module "%s"',
                            args.module));
        }

        prop = modules[args.module].getProperty(args.name);
        if (!prop) {
            throw new NefError('ENOENT', __('Failed to find property "%s" ' +
                        'in sysconfig module "%s"', args.name, args.module));
        }
    } else if (args.publicName) {
        prop = propsByPublicName[args.publicName];
        if (!prop) {
            throw new NefError('ENOENT',
                        __('Failed to find property with publicName "%s"',
                            args.publicName));
        }
    } else {
        throw new NefError('EBADARG',
                    __('Please specify id or publicName ' +
                        'or module + name arguments'));
    }

    if (!prop.isForVersion(args.apiVersion)) {
        throw new NefError('ENOENT',
                     __('Given property exists, but it\'s resticted ' +
                        'for API: %s', prop.compatVersions.join(', ')));
    }

    return prop;
};

main.setProperty = function(ctx, args, done) {
    var prop;

    // Default validator failes to detect empty arrays. Workaround
    if (args.value === undefined) {
        return done(NefError('EBADARG',
                    __('No value provided for property %s',
                    args.id || args.name)));
    }

    try {
        prop = main.lookupProperty(args);
    } catch (err) {
        done(err);
        return;
    }

    prop.set({
        ctx: ctx,
        persistent: args.persistent,
        strict: args.strict,
        value: args.value
    }, done);
};

/**
 * Used by property finder method. Get list of properties with matching
 * substring and with proper compatVersions
 */
main.matchProperty = function(opts) {
    var result = [];

    for (var id in props) {
        var prop = props[id];

        try {
            if (!prop.containsSubstring(opts.anythingMatches)) {
                continue;
            }

            if (!prop.isForVersion(opts.apiVersion)) {
                continue;
            }
        } catch (err) {
            logger.warn(__('Skip property %s: %s',
                            id, err.toString()));
            continue;
        }

        result.push(props[id].toJson('full'));
    }
    return result;
};

/**
 * Reboot needed event emitting
 */
main.emitRebootNeededEvent = function() {
    if (rebootNeededTimer) {
        clearTimeout(rebootNeededTimer);
        rebootNeededTimer = undefined;
    }

    var list = [];
    for (var id in props) {
        if (props[id].rebootNeeded) {
            list.push(id);
        }
    }

    if (list.length > 0) {
        events.jointEvent('NEF_sysconfig_rebootNeeded', {
            ids: list
        });
        logger.warn(__('An updated property requires reboot to apply' +
                    ' values'));
    }

    rebootNeededTimer = setTimeout(main.emitRebootNeededEvent,
           commonConfig.sysconfigEmitInterval);
};

/**
 * Return the last or currently running import job instance.
 */
main.getImportJob = function() {
    if (!importJobInstance) {
        return null;
    }
    return importJobInstance;
};

/**
 * Configuration importer helper
 */
main.doImport = function(args) {
    var isRunning = (importJobInstance !== undefined) &&
        (['done', 'failed'].indexOf(importJobInstance.status) === -1);

    if (isRunning) {
        throw NefError('EEXIST', __('Import job is already running, ' +
                    'abort it or wait before starting next import job'));
    }

    var instance = new ImportJob(modules);
    instance.load(args.configuration);

    var context = new Context({
        type: args.type || 'restore',
        name: args.context,
        args: {
            force: args.force || false,
            overwriteMetaInfo: args.overwriteMetaInfo || false
        }
    });

    importJobInstance = instance;
    process.nextTick(function() {
        importJobInstance.exec(context);
    });
};

/**
 * Configuration export helper
 */
main.doExport = function(args, done) {

    async.map(Object.keys(modules), function(id, next) {
        modules[id].doExport(args, next);
    }, function(err, list) {
        if (err) {
            return done(err);
        }

        list = list.filter(function(el) {
            return !!el;
        });

        var config = {
            version: GLOBAL_CONFIG_VERSION,
            generated: new Date().toISOString(),
            modules: list,
        };

        done(undefined, JSON.stringify(config, null, 2));
    });
};

/**
 * Add new profile to list of profiles.
 */
main.installProfile = function(name, prof) {
    logger.debug(__('Installed profile %s', name));
    profiles[name] = prof;
};

/**
 * Lookup profile by name. If name is unspecified then return all
 * profiles.
 */
main.lookupProfile = function(name) {
    if (name) {
        if (profiles[name] === undefined) {
            throw new NefError('ENOENT', __('Profile %s not found', name));
        }
        return profiles[name];
    } else {
        return profiles;
    }
};

main.waitingForImport = function(done) {
    if (importJobInstance === undefined) {
        var msg = __('There is no active or completed jobs');
        return done(NefError('ENOENT', msg));
    }
    var finished = false;
    var iteration = 0;
    var jobStatus = 'undefined';
    async.whilst(
        function testEnd() {
            return !finished && (iteration++ <= 50);
        },
        function checkJob(next) {
            finished = importJobInstance.finished;
            if (finished) {
                next();
            } else {
                setTimeout(next, 1000);
            }
        },
        function lastCheck() {
            if (importJobInstance.status === 'done') {
                done();
            } else if (importJobInstance.status === 'running') {
                done(NefError('ETIMEDOUT',
                              __('Operation took too long, ' +
                                 'use getImportJob to check when ' +
                                 'it\'s done')));
            } else {
                done(NefError('ENOENT', __('Import job failed')));
            }
        }
    );
};

module.exports = main;
