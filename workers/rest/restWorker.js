#!/usr/bin/env node

/*
 * Atomic REST worker.
 *
 * Copyright (C) 2014-2017 Nexenta Systems, Inc
 * All rights reserved.
 */

var assert    = require('assert');
var path      = require('path');
var async     = require('async');
var worker    = require('nef/baseWorker');
var logger    = require('nef/logger');
var utils     = require('nef/utils');
var interop   = require('nef/interop');
var events    = require('nef/events');
var NefError    = require('nef/error').NefError;
var schemaUtils = require('nef/schemaUtils');
var keysSchema  = require('nef/schemas/apiKeys');

var Server    = require('./restServer');
var schemas   = require('./restSchemas');

var commonConfig = utils.requireConfig('config/common');
var config = utils.requireConfig('config/rest');
var server;

var ha = {
    vips: {},
    services: {}
};

// sorted from the most recent to the oldest
var supportedVersions = [config.apiVersion, '1.1.15', '1.0.18'];

events.declare('NEF_rest_instance_start', {
    description: 'Instance has been started',
    range: 'joint',
    payload: {
        type: 'object'
    }
});

events.declare('NEF_rest_instance_stop', {
    description: 'Instance has been stopped',
    range: 'joint',
    payload: {
        type: 'object'
    }
});

events.declare('NEF_rest_configuration_updated', {
    description: 'REST server has been applied new configuration',
    range: 'joint',
    payload: {
        type: 'object'
    }
});

// set extra long timeout for all interop calls in REST worker to avoid ZMQ
// timeout errors if REST timeout is long
interop.setDefaultTimeout(config.zmqDefaultTimeout);

// sysconfig configuration for REST worker
var workerConfig = new worker.initConfig({
    version: 1,
    worker: worker,
    publicNamePrefix: 'rest.',
    properties: [{
        // this is used by sysconfig auth plugin
        name: 'users',
        description: __('REST user accounts'),
        default: [],
        schema: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    username: {
                        type: 'string',
                        description: 'Login name',
                        required: true
                    },
                    password: {
                        encrypted: true,
                        decryptErrorValue: '',
                        type: 'string',
                        description: 'Password',
                        required: true
                    },
                    accessLevel: {
                        type: 'string',
                        description: 'Access level',
                        required: true,
                        enum: [
                            'viewer',
                            'user',
                            'admin',
                            'root'
                        ]
                    }
                }
            }
        }
    }, {
        name: 'https',
        publicName: true,
        description: __('Enable TLS/SSL for the REST server'),
        default: true,
        schema: {type: 'boolean'}
    }, {
        name: 'auth',
        publicName: true,
        description: __('Enable authentication for the REST server'),
        default: true,
        schema: {type: 'boolean'}
    }, {
        name: 'port',
        publicName: true,
        description: __('Port for HTTP connections'),
        default: config.serverPort,
        schema: schemaUtils.common.port
    }, {
        name: 'securePort',
        publicName: true,
        description: __('Port for HTTPS connections'),
        default: config.secureServerPort,
        schema: schemaUtils.common.port
    }, {
        name: 'traceRequests',
        description: __('Enable request logging'),
        default: config.traceRequests,
        schema: {type: 'boolean'}
    }, {
        name: 'allowOrigin',
        publicName: true,
        description: __('Value for Acess-Control-Allow-Origin header'),
        default: config.allowOrigin || 'none',
        schema: {
            description: '"none", "*" or allowed origins separated with space',
            type: 'string'
        }
    }, {
        name: 'useSwagger',
        publicName: true,
        description: __('Enable Swagger API documentation'),
        default: false,
        schema: {type: 'boolean'}
    }, {
        name: 'managementAddress',
        publicName: true,
        description: __('List of IPs for the REST server to listen'),
        default: [],
        schema: {
            type: 'array',
            items: {
                description: 'Host IPv4 or IPv6 address except: 0.0.0.0,' +
                             ' ::, 127.0.0.1, ::1',
                type: 'string',
                anyOf: [
                    {'format': 'ipv4'},
                    {'format': 'ipv6'}
                ],
                not: [
                    {pattern: '^0.0.0.0$'},
                    {pattern: '^127.0.0.1$'},
                    {pattern: '^::$'},
                    {pattern: '^::1$'}
                ]
            },
            uniqueItems: true
        },
        apply(data, done) {
            if (!data.value) {
                return done();
            }

            for (let ipaddr of data.value) {
                if (!utils.isBindableAddress(ipaddr)) {
                    return done(NefError('EBADARG', __('Address %s is not local address',
                                                       ipaddr)));
                }
            }

            done();
        }
    }, {
        name: 'useLandingPage',
        publicName: true,
        description: __('Enable Landing Page'),
        default: true,
        schema: {type: 'boolean'}
    }, {
        name: 'httpsProtocol',
        publicName: true,
        description: __('Enforced protocol in https connections'),
        default: 'TLS1.2',
        schema: {
            type: 'string',
            enum: ['TLS1.x', 'TLS1.2']
        }
    }, {
        // Used by API Keys rest plugin
        name: 'apiKeys',
        description: __('REST API keys'),
        default: [],
        schema: {
            type: 'array',
            items: keysSchema.apiKey
        }
    }]
});

worker.info(require('./worker.json'));

/**
 * Return List of API URLs supported by REST API
 *
 * @param None
 *
 * @returns {restUrl[]} List of API URLs
 */
worker.apiMethod('getRestUrls', {
    input: schemas.nullInput,
    output: schemas.restUrl,
}, function(args, done) {
    var urls = {};

    // group actions for the same URL together
    server.getRegisteredUrls().forEach(function(ent) {
        var url = '/' + ent.version + ent.url;

        if (!urls[url]) {
            urls[url] = {};
        }
        assert(!urls[url][ent.action]);
        urls[url][ent.action] = ent.description;
    });
    done(null, urls);
});

worker.apiMethod('getStatus', {
    input: schemas.nullInput,
    output: {
        type: 'object',
        properties: {
            apiVersion: {
                type: 'string',
                description: 'Current API version of the REST API'
            }
        }
    }
}, function(args, done) {
    var instances = {};
    for (var id in server.instances) {
        instances[id] = utils.sliceObject(server.instances[id],
                        'address', 'port', 'https', 'useSwagger',
                        'httpsProtocol', 'redirectTo');
    }
    done(null, {
        apiVersion: supportedVersions[0],
        instances: instances
    });
});

/**
 * Returns function that could be used as callback.
 * It will update restServer configuration and schedules reloader
 * to restart intances if needed.
 */
function reconfigure(param, data) {
    var newConfig = {};
    if (param) {
        newConfig[param] = data.value;
    }

    worker.lockManager.lock(['restart'], function(unlock) {
        server.updateInstances(newConfig, (err) => {
            unlock();
            if (err) {
                logger.error(err);
                worker.exit(10);
            }
            utils.debounce('reloader', () => {
                server.reload((err) => {
                    if (err) {
                        logger.error(__('Failed to reload: %s', err));
                        worker.exit(10);
                    }
                    events.jointEvent('NEF_rest_configuration_updated', {
                        config: server.config
                    });
                });
            }, 1000);
        });
    });
}

function getVips(done) {
    interop.call('procman', 'findWorkers', {
        where: {name: 'rsf'},
        fields: ['running']
    }, function(err, data) {
        if (err) {
            logger.error(__('Failed find rsf worker: %s', err.toString()));
            return done();
        }
        const rsf = data[0];
        if (rsf && rsf.running) {
            _getVips(done);
        } else {
            logger.warn(__('Rsf worker is not running - skip VIPs detection'));
            done();
        }
    });
}

function _getVips(done) {
    var hostName;
    async.waterfall([
        function(next) {
            interop.call('sysconfig', 'getProperty', {
                id: 'unix.hostName'
            }, next);
        },
        function(res, next) {
            hostName = res;
            interop.call('rsf', 'getVips',  {
                timeout: 15000
            }, next);
        },
        function(res, next) {
            if (!res) {
                return next();
            }
            res.forEach(function(vip) {
                const nodeMapping = vip.nodeMapping;
                if (nodeMapping) {
                    nodeMapping.forEach(function(mapping) {
                        if (mapping.status == 'up') {
                            if (mapping.node == hostName) {
                                ha.vips[vip.vipName] = vip.ipAddress;
                                ha.services[vip.serviceName] = vip.vipName;
                            }
                        }
                    });
                }
            });
            next();
        },
    ], function(err) {
        if (err) {
            logger.error(__('Failed to get HA cluster VIP address: %s',
                            err.toString()));
        }
        done();
    });
};

function removeVip(vip) {
    let services = {};
    for (var name in ha.services) {
        const vipName = ha.services[name];
        if (vipName != vip) {
            services[name] = vipName;
        }
    };

    let vips = {};
    for (var name in ha.vips) {
        const ipAddress = ha.vips[name];
        if (name != vip) {
            vips[name] = ipAddress;
        }
    };

    ha.vips = vips;
    ha.services = services;
}

async.waterfall([
    function(next) {
        workerConfig.init(next);
    },
    function(next) {
        getVips(next);
    },
    function(next) {
        // get management ip or interface
        interop.call('sysconfig', 'getProperty', {
            id: 'nef.managementAddress'
        }, next);
    },
    function(address, next) {
        var opts = {
            debugMode: config.debugMode,
            extendedValidation: commonConfig.extendedValidation,
            pluginDirs: config.pluginDirs,
            apiDirs: config.apiDirs,
            workerConfig: workerConfig,

            https: workerConfig.get('https'),
            address: address,
            vips: ha.vips,
            localPort: config.localPort,
            port: workerConfig.get('port'),
            securePort: workerConfig.get('securePort'),
            useSwagger: workerConfig.get('useSwagger'),
            managementAddress: workerConfig.get('managementAddress'),
            httpsProtocol: workerConfig.get('httpsProtocol'),
            useLandingPage: workerConfig.get('useLandingPage'),
        };

        if (config.certs && config.certs.crt && config.certs.key) {
            opts.certificateFile = path.join(utils.getRootPath(),
                                             config.certs.crt);
            opts.keyFile = path.join(utils.getRootPath(), config.certs.key);
        }
        server = new Server(supportedVersions, opts);

        logger.debug('Configuring REST server');
        server.configure(next);
    },
    function(next) {
        logger.debug('Starting REST server');
        server.start({}, next);
    }
], function(err) {
    if (err) {
        logger.error(__('Failed to start REST server: %s', err.toString()));
        worker.exit(10);
        return;
    }

    // watch management interface address
    events.private.on('NEF_sysconfig_set_param', function(data) {
        if (data.id === 'nef.managementAddress') {
            reconfigure('address', data);
        } else if (data.id === 'nef.security.httpsCertificate') {
            reconfigure(undefined, data);
        }
    });

    events.private.on('RSF_zpool_import_event', function(args) {
        if (args.operation == 'complete') {
            const pool = args.pool;
            const vip = ha.services[pool];
            if (!vip) {
                async.series([
                    function(next) {
                        getVips(next);
                    },
                    function(next) {
                        const data = {
                            value: ha.vips
                        };
                        reconfigure('vips', data);
                        next();
                    }
                    ], function(err) {
                        if (err) {
                            logger.error(__('Failed to update REST server: %s',
                                            err.toString()));
                        }
                    });
            }
        }
    });

    events.private.on('RSF_zpool_export_event', function(args) {
        if (args.operation == 'complete') {
            const pool = args.pool;
            const vip = ha.services[pool];
            if (vip) {
                removeVip(vip);
                const data = {
                    value: ha.vips
                };
                reconfigure('vips', data);
            }
        }
    });

    workerConfig.on('changed:https', reconfigure.bind(this, 'https'));
    workerConfig.on('changed:port', reconfigure.bind(this, 'port'));
    workerConfig.on('changed:securePort', reconfigure.bind(this, 'securePort'));
    workerConfig.on('changed:useSwagger', reconfigure.bind(this, 'useSwagger'));
    workerConfig.on('changed:managementAddress',
                    reconfigure.bind(this, 'managementAddress'));
    workerConfig.on('changed:useLandingPage',
                    reconfigure.bind(this, 'useLandingPage'));
    workerConfig.on('changed:httpsProtocol',
                    reconfigure.bind(this, 'httpsProtocol'));

    worker.start();
});
