/**
 * @fileOverview Generic REST server implementation.
 *
 * Copyright (C) 2014-2016 Nexenta Systems, Inc
 * All rights reserved.
 */

var _       = require('lodash');
var os      = require('os');
var assert  = require('assert');
var async   = require('async');
var restify = require('restify');
var http    = require('http');
var url     = require('url');
var path    = require('path');
var fs      = require('fs');
var url     = require('url');
var logger  = require('nef/logger');
var utils   = require('nef/utils');
var events  = require('nef/events');
var NefError    = require('nef/error').NefError;
var schemaUtils = require('nef/schemaUtils');
var restUtils   = require('nef/restUtils');
var escapeHtml = require('escape-html');
var interop = require('nef/interop');

var restConvert = require('./restConvert');
var collection  = require('./restCollection');
var jobManager  = require('./restJobManager');
var flamegraph  = require('./restFlamegraph');
var ApiVersion = require('./restVersion').ApiVersion;

var restConfig = utils.requireConfig('config/rest');

var DEFAULTS = {
    https: false,
    keyFile: null,
    certificateFile: null,
    localPort: 2020,
    port: 8080,
    securePort: 8443,
    address: '127.0.0.1',
    vips: {},
    managementAddress: [],
    useSwagger: false,
    useLandingPage: true,
    httpsProtocol: 'TLS1.2'
};

const XSS_PROTECTION = 'X-XSS-Protection';
const API_VERSION = 'X-API-Version';
const LATEST_API_VERSION = 'X-Latest-API-Version';
const LANDING_TEMPLATE = path.join(process.env.NEF_CORE_ROOT,
                                   'workers/rest/templates',
                                   'landing.html.template');

var restifyServerConfig = {
    formatters: {
        // html formatter is needed for flamegraphs plugin,
        // priority is set explicitly to keep json content type first
        'text/html; q=0.05': function(req, res, body, cb) {
            if (!Buffer.isBuffer(body) && typeof body !== 'string') {
                if (!body) {
                    body = '';
                } else {
                    body = body.toString();
                }
            }
            return cb(null, body);
        }
    }
};

/**
 * Class for representing a REST server that uses the 'restify' framework.
 *
 * @param {String[]} versions  Supported versions of the server API (sorted from newer to older).
 * @param {Object}   [args]    Optional arguments.
 */
function RestServer(versions, args) {
    args = args || {};
    assert(versions.length > 0);

    this.versions = versions.map(v => new ApiVersion(v));
    this.bendApiMap = {};  // API definition grouped by backends
    this.trees = {};       // Resource trees starting from root "/" for each supported version
    this._debugMode = args.debugMode || false;
    this._extendedValidation = args.extendedValidation || false;
    this.plugins = {};     // Lookupable Dict with loaded plugins
    this.bends = [];       // List with loaded bends modules
    this._pluginDirs = args.pluginDirs || [];
    this._bendPaths = args.apiDirs || [];
    this._beforeAll = [];
    this._afterAll = [];
    this._customHeaders = [];
    this.workerConfig = args.workerConfig;

    // Instances configuration
    this.runningInstances = {};                // Running instances
    this.instances = {};                       // Instances configurations
    this.config = utils.extend({}, DEFAULTS);  // Global config
    utils.extend(this.config, utils.sliceObject(args, Object.keys(DEFAULTS)));
}

/**
 * Create a restify server and set its parameters
 *
 * @param {Object} cfg   Configuration options (key-value object).
 * @returns {Object}     Server object
 */
RestServer.prototype.setupServer = function(cfg) {
    var self = this;
    var server = restify.createServer(cfg);
    var parenthRe = /\([^)]*\)/g;

    // Check whether the requested URL/method is a part of the API
    function isApiRequest(req) {
        return !(req.path().indexOf('/docs') === 0 ||
            req.path().indexOf('/flamegraphs') === 0);
    }

    server.pre(function(req, res, next) {
        // filtering by whitelist only if listen on all interfaces
        if (self.config.address !== '0.0.0.0') {
            return next();
        }

        // skip local connections
        if (req.connection.remoteAddress === '127.0.0.1') {
            return next();
        }

        const host = req.headers.host;
        if (!host) {
            return next();
        }

        next();
    });

    // Preprocess URL, replacing path in () with %2F-encoded paths (not in
    // query string!)
    server.pre(function decodeParenthesis(req, res, next) {
        var urlObj = url.parse(req.url);
        urlObj.pathname = urlObj.pathname.replace(parenthRe, function(m) {
            var s = m.slice(1, -1);
            s = decodeURIComponent(s);
            return encodeURIComponent(s);
        });
        req.url = url.format(urlObj);
        return next();
    });

    // Handle X-XSS-Protection flag. Configure response header in advance.
    server.pre(function(req, res, next) {
        req.serverParams = {};

        // By default:
        //   1. local clients are not escaped.
        //   2. In 'test' environment output is not escaped.
        req.serverParams.escapeHtml =
            req.connection.remoteAddress !== '127.0.0.1' &&
            process.env.NEF_ENV !== 'test';

        // Check for X-XSS-Protection flag to override default setting.
        // 1 disables RSS escaping, 0 turns it on.

        var xssProtection = _.find(req.headers,
            (val, key) => key === XSS_PROTECTION.toLowerCase());
        if (xssProtection === '1') {
            req.serverParams.escapeHtml = false;
        } else if (xssProtection === '0') {
            req.serverParams.escapeHtml = true;
        }

        res.header(XSS_PROTECTION,
            req.serverParams.escapeHtml ? '0' : '1; mode=block');
        next();
    });

    //Extract version from headers or URLs
    server.pre(function(req, res, next) {
        // don't interpret/touch version on methods which are not part of API
        if (!isApiRequest(req)) {
            return next();
        }
        try {
            var ver = decodeVersion(req, self.versions);
            ver.expandToOrDie(self.versions);
            req.apiVersion = ver;
            req.headers[API_VERSION.toLowerCase()] = ver.toString();
            req.latestVersion = self.versions[0];
        } catch (err) {
            self.sendError(req, res, err);
            return;
        }

        if (self.workerConfig.get('traceRequests')) {
            logger.debug(`${req.method} [${req.apiVersion}] ${req.url}`);
        }

        res.header(API_VERSION, req.apiVersion);
        if (req.apiVersion.toString() != req.latestVersion.toString()) {
            res.header(LATEST_API_VERSION, req.latestVersion);
        }

        next();
    });

    server.use(restify.gzipResponse());
    server.use(restify.fullResponse());
    server.use(restify.acceptParser(server.acceptable));
    server.use(restify.bodyParser({
        mapParams: false // disable mapping of body into req.params
    }));
    server.use(restify.queryParser({
        mapParams: false // disable mapping of query keys into req.params
    }));

    // Expose sendError method to res object.
    // This method can be used by rest plugins to generate
    // proper errors when breaking middleware chain
    server.use(function(req, res, next) {
        res.sendError = function(err) {
            self.sendError(req, res, err);
        };
        next();
    });

    server.use((req, res, next) => {
        res.once('header', function() {
            var origin = self.workerConfig.get('allowOrigin');

            if (!origin || ['none', 'disabled'].indexOf(origin) > -1) {
                res.removeHeader('Access-Control-Allow-Origin');
            } else {
                res.setHeader('Access-Control-Allow-Origin', origin);
            }
        });
        next();
    });

    // We need to override all restify error handlers to supply NefError
    // objects instead of RestError objects which are not compatible.
    server.on('uncaughtException', function(req, res, ctx, err) {
        self.sendError(req, res,
                NefError(err, __('Unexpected exception in REST server')));
    });
    server.on('MethodNotAllowed', function(req, res) {
        if (req.method.toLowerCase() === 'options') {
            // X-Password and x-xss-protection headers should be in
            // Access-Control-Allow-Headers to complete CORS preflighted request
            var allowHeaders = [
                'Accept', 'Accept-Version', 'Content-Type', 'Authorization',
                'Origin', 'X-Requested-With', 'X-Password', XSS_PROTECTION
            ];

            if (self._customHeaders.length > 0) {
                allowHeaders = allowHeaders.concat(self._customHeaders);
                allowHeaders = allowHeaders.filter(function(el, pos) {
                    return allowHeaders.indexOf(el) === pos;
                });
            }

            if (res.methods.indexOf('OPTIONS') === -1) {
                res.methods.push('OPTIONS');
            }

            res.header('Access-Control-Allow-Credentials', true);
            res.header('Access-Control-Allow-Headers', allowHeaders.join(', '));
            res.header('Access-Control-Allow-Methods', res.methods.join(', '));
            res.header('Access-Control-Allow-Origin', req.headers.origin);

            res.send(204);
        } else {
            res.json(405, new NefError('EACCES',
                    __('%s method on %s not allowed',
                    req.method, _escapeResult(req, req.path()))).serialize());
        }
    });
    server.on('NotFound', function(req, res) {
        res.json(404, new NefError('ENOENT',
                __('%s does not exist', _escapeResult(req, req.path()))).serialize());
    });

    // XXX this is currently never triggered because we don't restrict content
    // types and that's wrong and should be fixed. However when restricting
    // types beware that we don't return just json but also html (i.e.
    // flamegraphs).
    server.on('UnsupportedMediaType', function(req, res) {
        res.json(415, new NefError('EINVAL',
                __('Unsupported media type %s', req.headers['content-type']))
                .serialize());
    });

    server.on('VersionNotAllowed', function(req, res) {
        res.json(404, new NefError('ENOENT',
                __('Path %s is not available in API version %s',
                    _escapeResult(req, req.path()), req.apiVersion.toString(true)))
                .serialize());
    });

    server.on('after', function(req, res) {
        if (isApiRequest(req) && self.workerConfig.get('traceRequests')) {
            logger.debug(__('Request complete: %s [%s] %s (%s) (%s ms)',
                req.method, req.apiVersion.toString(), req.url, res.statusCode,
                res._headers['response-time']));
        }
    });

    server.use(function(req, res, next) {
        // Forbid to paste swagger ui via iframe
        res.setHeader('X-Frame-Options', 'DENY');

        // force browser to use only https connection
        if (self.https) {
            res.setHeader('Strict-Transport-Security', 'max-age=31536000');
        }

        next();
    });
    // Register swagger-ui static files
    if (self.config.useSwagger) {
        self._registerStatic(server, '/docs',
            process.env.NEF_CORE_ROOT + '/node_modules/swagger-ui');
    }

    flamegraph.register(server, '/flamegraphs');

    return server;
};

/**
 * Simple REST server used to redirect all requests to another port
 */
RestServer.prototype.setupRedirector = function(config) {
    return http.createServer(
        function reqHandler(req, res) {
            var port = config.redirectTo;
            var proto = 'https://';

            if (utils.isLoopback(req.connection.remoteAddress)) {
                port = config.localRedirectTo;
                proto = 'http://';
            }

            var host = req.headers.host;
            if (host) {
                host = host.slice(0, host.lastIndexOf(':'));
            } else {
                host = config.address;
            }

            var newLocation = proto + quoteIpv6(host) + ':' + port +
                              req.url;

            res.writeHead(302, {
                'Location': newLocation
            });

            res.write('New location: ' + newLocation + '\n');
            res.end();
        }
    );
};

RestServer.prototype.setupLandingPage = function() {
    var self = this;

    return http.createServer(
        function reqLandingHandler(req, res) {
            async.parallel({
                template: (next) => fs.readFile(LANDING_TEMPLATE, next),
                settings: (next) => {
                    interop.call('sysconfig', 'findProperties', {
                        where: {
                            idIn: [
                                'unix.hostDomainName',
                                'nef.federation.enabled',
                                'nef.federation.compound.service'
                            ]
                        },
                        includeCurrentValues: true
                    }, next);
                }
            }, (err, data) => {
                if (err) {
                    logger.error(__('Failed to generate landing page: %s',
                                    err.toString()));
                    res.write(501, 'Failed to generate landing page. ' +
                                   'See logs for details');
                    res.end();
                } else {
                    var settings = utils.arrayToDict(data['settings'], 'id',
                                                    'currentValue');
                    var vars = {
                        host: req.headers.host,
                        hostDomainName: settings['unix.hostDomainName'],
                        useSwagger: self.config.useSwagger,
                        fedEnabled: settings['nef.federation.enabled'],
                        fedHost: settings['nef.federation.compound.service']
                                         ['host']
                    };

                    res.write(_.template(data['template'])(vars));
                    res.end();
                }
            });
        }
    );
};

/**
 * Configure a REST server and install API backends.
 * This function must be called before starting the server.
 *
 * @param {Function} cb   Completion handler to be invoked after initialization
 *                        is done.
 */
RestServer.prototype.configure = function(cb) {
    var self = this;
    async.series([
        self.updateInstances.bind(self),
        self._loadAllPlugins.bind(self),
        self._expandBendDirs.bind(self),
        self._loadAllBends.bind(self),
        self._registerApiBackends.bind(self),
    ], function(err) {
        cb(err);
    });
};

/**
 * Do loading for plugins
 *
 * It also respects dependency, so if some plugin
 * depends on another, then it's loading will be deferred to the end
 */
RestServer.prototype._loadAllPlugins = function(done) {
    var self = this;
    var queue = [];
    var tryAgain = false;
    var toSort = [];

    self._pluginDirs.forEach(function(dir) {
        toSort = toSort.concat(self._loadPlugins(dir));
    });

    // Reorder plugins into the queue with respect to dependency
    do {
        var startLength = queue.length;
        var current = toSort;
        toSort = [];
        current.forEach(function(plugin) {
            if (plugin === undefined) {
                return;
            }

            var okToLoad = plugin.requirePlugins.every(function(id) {
                return queue.some(function(el) {
                    return el.id === id;
                });
            });

            if (okToLoad) {
                queue.push(plugin);
            } else {
                toSort.push(plugin);
            }
        });

        tryAgain = queue.length > startLength; // not useless round
    } while (toSort.length > 0 && tryAgain);

    // In toSort we now have only those plugins
    // that depends on missing plugins
    toSort.forEach(function(plugin) {
        logger.error(__('Skip plugin %s because it depends on missing plugin',
                     plugin.filePath));
    });

    // Do normal loading
    async.eachSeries(queue, function(plugin, next) {
        self._initPlugin(plugin, function(err) {
            if (err) {
                logger.error(__('Unable to initialize plugin %s: %s',
                                plugin.filePath, err.toString()));
            }
            next();
        });
    }, done);
};

RestServer.prototype._loadPlugins = function(dir) {
    var self = this;
    var plugins = [];

    // this is used only when starting REST, we can use sync method
    fs.readdirSync(dir).forEach(function(ent) {
        var file = path.join(dir, ent);
        try {
            var plugin = require(file);
        } catch (e) {
            console.log(e.stack);
            logger.error(__('Unable to load plugin %s: %s',
                         file, e.toString()));
            return;
        }

        // Default values for some props
        function emptyHook() {
            utils.toArray(arguments).pop()();
        }

        plugin.filePath = file;
        plugin.id = plugin.id || file;
        plugin.init = plugin.init || emptyHook;
        plugin.initInstance = plugin.initInstance || emptyHook;
        plugin.requirePlugins = plugin.requirePlugins || [];

        plugins.push(plugin);
    });

    return plugins;
};

RestServer.prototype._initPlugin = function(plugin, done) {
    var self = this;
    logger.info(__('Initializing REST Worker plugin: %s', plugin.filePath));

    var okToLoad = plugin.requirePlugins.every(function(id) {
        return self.plugins.hasOwnProperty(id);
    });

    if (!okToLoad) {
        return done(new NefError('EINVAL', __('Dependency failed to load')));
    }

    async.series([
        plugin.init.bind(plugin, self),
        function afterInitSetup(next) {
            if (plugin.beforeAll && Array.isArray(plugin.beforeAll)) {
                self._beforeAll = self._beforeAll.concat(plugin.beforeAll);
            }
            if (plugin.afterAll && Array.isArray(plugin.afterAll)) {
                self._afterAll = self._afterAll.concat(plugin.afterAll);
            }
            if (plugin.customHeaders && Array.isArray(plugin.customHeaders)) {
                self._customHeaders = self._customHeaders.concat(
                        plugin.customHeaders);
            }
            if (plugin.apiDirs && Array.isArray(plugin.apiDirs)) {
                self._bendPaths = self._bendPaths.concat(plugin.apiDirs);
            }

            self.plugins[plugin.id] = plugin;

            next();
        },
    ], done);
};

/**
 * Function recursively tries to expand all dirs that
 * represents collection of API backends.
 *
 * As result self._bendPaths should result in
 * list of paths to explicit API Backends
 */
RestServer.prototype._expandBendDirs = function(done) {
    var self = this;
    var result = [];
    var files = self._bendPaths;

    // returns true or false
    // warn: does not emit errors
    function isFile(file, helperDone) {
        fs.stat(file, function(err, res) {
            helperDone(null, !err && res.isFile());
        });
    }

    // helper to check is this is loadable module
    // warn: does not emit errors in cb!
    function canBeRequired(file, helperDone) {
        async.some([
            path.extname(file) === '.js' ? file : file + '.js',
            path.join(file, 'index.js')
        ], isFile, helperDone);
    }

    // helper to look for loadable subdirs
    function lookInside(file, helperDone) {
        async.waterfall([
            fs.readdir.bind(this, file),
            function(list, next) {
                var newList = list.map(function(name) {
                    return path.join(file, name);
                });
                expand(false, newList, next);
            }
        ], function(err) {
            if (err) {
                logger.warn(__('Can\'t look inside %s: %s', file, err));
            }
            helperDone();
        });
    }

    // helper to expand given list of files
    function expand(recursive, files, helperDone) {
        async.forEach(files, function(file, next) {
            canBeRequired(file, function(err, res) {
                if (res) {
                    result.push(file);
                    return next();
                }

                if (recursive) {
                    return lookInside(file, next);
                }

                logger.warn(__('Ignoring %s - not a backend path', file));
                next();
            });
        }, helperDone);
    }

    expand(true, files, function() {
        self._bendPaths = result;
        done();
    });
};

RestServer.prototype._loadAllBends = function(done) {
    var self = this;

    // recursivelly load all API backends from _bendPaths
    async.eachSeries(self._bendPaths, function(file, next) {
        self._loadBend(file, function(err) {
            if (err) {
                logger.error(__('Unable to load API backend %s: %s',
                                file, err.toString()));
            }
            next();
        });
    }, done);
};

RestServer.prototype._loadBend = function(file, done) {
    var self = this;
    var module;

    async.series([
        function(next) {
            try {
                // this should automatically handle <file>/index.js
                // and <file.js> cases
                module = require(file);
            } catch (e) {
                return next(new NefError(e, 'EINVAL',
                     __('Failed to load API backend %s', file)));
            }

            next();
        },
        function(next) {
            if (module.skip) {
                logger.warn(__('Skipping REST API module %s', module.name));
                return next();
            }

            self.bends.push(module);

            next();
        }
    ], done);
};

/**
 * Get the list of all REST API URLs served by REST server.
 *
 * @returns {array} List of objects that represent all REST API URLs.
 *                  Every object has the following fields:
 *                      url:          REST API URL
 *                      action:       GET | PUT | POST | DELETE | HEAD
 *                      description:  Description of the method
 */
RestServer.prototype.getRegisteredUrls = function() {
    var urls = [];

    var mdesc;

    for (var b in this.bendApiMap) {
        for (var m in this.bendApiMap[b].methods) {
            mdesc = this.bendApiMap[b].methods[m];

            for (var v in mdesc.versions) {
                var versionedMdesc = mdesc.versions[v];
                urls.push({
                    url: versionedMdesc.url,
                    version: v,
                    action: restUtils.mapHTTPMethod(versionedMdesc.action).usr,
                    description: versionedMdesc.description
                });
            }
        }
    }
    return urls;
};

/**
 * Start all REST server instances.
 *
 * Arguments:
 *  {String[]}    [args.ids]     list of instance ids to start
 */
RestServer.prototype.start = function(args, done) {
    var self = this;
    if (!done) {
        done = args;
        args = {};
    }
    args.ids = args.ids || Object.keys(self.instances);

    async.forEachSeries(args.ids, (id, next) => {
        var config = self.instances[id];
        var ref;

        if (!config) {
            return next();
        }

        if (self.runningInstances[id]) {
            logger.debug(__('REST server "%s" is already running', id));
            return next();
        }

        if (config.redirectTo) {
            ref = self.setupRedirector(config);
        } else if (config.landing) {
            ref = self.setupLandingPage();
        } else {
            var options = utils.extend({}, restifyServerConfig);

            var protocol = undefined;
            var ciphers = undefined;

            if (config.httpsProtocol == 'TLS1.2') {
                logger.info('Enforce TLS1.2 method ' +
                            'for incoming HTTPS connections');
                protocol = 'TLSv1_2_method';
                ciphers = restConfig.tls12Ciphers ?
                          restConfig.tls12Ciphers.join(':') :
                          undefined;
            }

            if (config.https) {
                options['httpsServerOptions'] = {
                    cert: config.certificate,
                    key: config.key,
                    secure: true,
                    ciphers: ciphers,
                    secureProtocol: protocol
                };
            }

            ref = self.setupServer(options);
        }

        async.series([
            (cb) => {
                self.runningInstances[id] = {
                    id: id,
                    ref: ref,
                    hash: getConfigHash(config),
                    config: _.clone(config),
                    sockets: {},
                    socketId: 0,
                };
                cb();
            },
            // Init plugins
            (cb) => {
                if (config.noApi) {
                    return cb();
                }

                async.forEach(Object.keys(self.plugins), (name, nPlug) => {
                    self.plugins[name].initInstance(ref, nPlug);
                }, cb);
            },
            // Install endpoints
            (cb) => {
                if (config.noApi) {
                    return cb();
                }

                // Walk through all version trees and register each mdesc
                var seenMdescs = [];
                async.forEachSeries(Object.keys(self.trees), (v, next) => {
                    logger.debug(__('Attaching API v%s to "%s"', v, id));
                    walkResourceTree(self.trees[v], (mdesc, next) => {
                        var handler = self._wrapUserHandler(mdesc);
                        self._installRestifyHandlers(mdesc, handler, false, id);
                        next();
                    }, (err) => {
                        setTimeout(() => {
                            next(err);
                        }, 10);
                    });
                }, cb);
            },
            // Setup socket collector
            (cb) => {
                ref.on('connection', (socket) => {
                    var socketId = self.runningInstances[id].socketId ++;
                    var sockets = self.runningInstances[id].sockets;
                    sockets[socketId] = socket;
                    socket.on('close', () => {
                        delete sockets[socketId];
                    });
                });

                ref.on('error', (err) => {
                    cb(err);
                });

                ref.listen(config.port, config.address, () => {
                    cb();
                });
            },
            (cb) => {
                logger.info(__('NEF REST %s instance "%s" listens on %s:%s',
                               config.https ? 'HTTPS' : 'http',
                               id, quoteIpv6(config.address), config.port));

                events.jointEvent('NEF_rest_instance_start', {
                    id: id,
                    config: utils.sliceObject(config,
                              'port', 'address',
                              'localRedirectTo',
                              'redirectTo', 'https',
                              'landing', 'noApi'),
                });
                cb();
            }
        ], (err) => {
            if (err) {
                delete self.runningInstances[id];
                if (ref) {
                    ref.close();
                }
                logger.error(__('Failed to start NEF REST instance "%s": %s',
                                id, err.toString()));
            }
            next();
        });
    }, done);
};

/**
 * Stop all REST server instances.
 *
 * Arguments:
 *  {String[]}    [args.ids]     list of instance ids to stop
 *  {Boolean}     [args.force]   if true, don't wait for sockets
 */
RestServer.prototype.stop = function(args, done) {
    if (!done) {
        done = args;
        args = {};
    }
    args.ids = args.ids || Object.keys(self.runningInstances);

    async.forEach(args.ids, (id, next) => {
        if (!this.runningInstances[id]) {
            return next();
        }

        if (!args.force) {
            logger.info(__('Gracefully close server "%s"', id));
        } else {
            logger.info(__('Close server "%s", destroy all connections', id));
            var sockets = this.runningInstances[id].sockets;
            for (socketId in sockets) {
                sockets[socketId].destroy();
            }
        }

        this.getInstance(id).close((arg1, arg2) => {
            var config = this.runningInstances[id].config;
            events.jointEvent('NEF_rest_instance_stop', {
                id: id,
                config: utils.sliceObject(config,
                          'port', 'address',
                          'redirectTo', 'https',
                          'landing', 'noApi')
            });

            delete this.runningInstances[id];
            next();
        });
    }, done);
};

/**
 * Restart all instances or given ones in args.ids param
 *
 * Arguments:
 *  {String[]}    [args.ids]     list of instance ids to restart
 *  {Boolean}     [args.force]   if true, don't wait for sockets
 */
RestServer.prototype.restart = function(args, done) {
    if (!done) {
        done = args;
        args = {};
    }

    async.series([
        (next) => this.stop(args, next),
        (next) => this.start(args, next),
    ], done);
};

/**
 * Compares running configuration with current config
 * and restarts only instances that have changes in config.
 * It also start/stops instances that appeared or disappeared
 * in instance's configurations
 */
RestServer.prototype.reload = function(done) {
    var toRestart = {};

    for (id in this.runningInstances) {
        if (!this.instances[id]) {
            toRestart[id] = true;
        }
    }

    for (id in this.instances) {
        if (!this.runningInstances[id]) {
            toRestart[id] = true;
            continue;
        }

        var conf = this.instances[id];
        var hash = getConfigHash(conf);
        if (this.runningInstances[id].hash !== hash) {
            toRestart[id] = true;
        }
    }

    var ids = Object.keys(toRestart);
    if (ids.length === 0) {
        return done();
    } else {
        this.restart({
            ids: Object.keys(toRestart),
            force: true
        }, done);
    }
};

/**
 * Public method to get running instance
 *
 * @return {undefined|Object}     http server instance
 */
RestServer.prototype.getInstance = function(id) {
    return (this.runningInstances[id] || {})['ref'];
};

/**
 * Public method to get configuration for running instance
 *
 * @return {undefined|Object} configuration
 */
RestServer.prototype.getInstanceConfig = function(id) {
    return (this.runningInstances[id] || {})['config'];
};

/**
 * Iterate over running instance, it will skip redirectors
 * Callback arguments:   (serv, [id, [config]])
 *   * serv - server instance (instance of http object)
 *   * id   - id of the instance
 *   * conf - configuration of the instance
 *
 * @param  {boolean}  [args]   Optional arguments
 * @param  {Function} cb       Will be called for each instance
 */
RestServer.prototype.forEachInstance = function(args, cb) {
    var res = [];
    if (!cb) {
        cb = args;
        args = {};
    }

    for (id in this.runningInstances) {
        var conf = this.getInstanceConfig(id);
        if (conf.noApi) {
            continue;
        }

        cb(this.getInstance(id), id, conf);
    }
};

/**
 * Analize current RestServer configuration and generate
 * two or more configurations for instances that should be started
 *
 * Always at least one:
 *   local - should be run for localhost connections
 *   server - should accept external requests. Can be http or https
 *   redirect - optional redirector from http port to https,
 *              if server is in https mode
 *
 * For each management address in case of multiple, we should run
 * additional pair of server/redirector.
 */
RestServer.prototype.updateInstances = function(newConfig, done) {
    var previousInstances = this.instances;
    this.instances = {};

    if (!done) {
        done = newConfig;
        newConfig = undefined;
    }
    utils.extend(this.config, newConfig || {});

    var address;
    try {
        address = selectInterface(this.config.address);
    } catch (exc) {
        logger.error(exc.message);
        logger.error(__('Using sane defaults.'));
        address = '0.0.0.0';
        this.config.address = address;
    }

    // Local server is alway here
    this.instances.local = {
        address: '127.0.0.1',
        port: this.config.localPort,
        useSwagger: this.config.useSwagger,
    };

    // Landing page
    if (this.config.useLandingPage) {
        this.instances.landing = {
            https: false,
            address: this.config.address,
            port: 80,
            landing: true,
            noApi: true
        };
    }

    // Calculate all public IPs for public port
    let publicBindings = [];

    if (!utils.isLoopback(this.config.address)) {
        publicBindings.push({
            key: 'server',
            address: this.config.address
        });
    }

    for (let vip in this.config.vips) {
        publicBindings.push({
            key: vip,
            address: this.config.vips[vip]
        });
    }

    if (!utils.isAllZeroesAddress(this.config.address)) {
        for (let ip of this.config.managementAddress) {
            publicBindings.push({
                key: 'rest_' + ip,
                address: ip
            });
        }
    }

    // No https -> run just normal http server
    // and EXIT
    if (!this.config.https) {
        for (binding of publicBindings) {
            this.instances[binding.key] = {
                https: false,
                address: binding.address,
                port: this.config.port,
                useSwagger: this.config.useSwagger,
            };
        }

        return done();
    }

    // If https -> run and https and redirector
    async.waterfall([
        // read cert files
        (next) => {
            async.map([
                this.config.keyFile,
                this.config.certificateFile
            ], fs.readFile, (err, res) => {
                if (err) {
                    logger.error(__('Failed to load certificates: %s', err.toString()));
                    next(undefined, null);
                } else {
                    next(undefined, res);
                }
            });
        },
        // get configurations
        (certs, next) => {
            if (!certs) {
                logger.warn(__('Skipping secure ports'));
                return next();
            }

            for (binding of publicBindings) {
                this.instances[binding.key] = {
                    https: true,
                    address: binding.address,
                    port: this.config.securePort,
                    key: certs[0].toString('utf-8'),
                    certificate: certs[1].toString('utf-8'),
                    useSwagger: this.config.useSwagger,
                    httpsProtocol: this.config.httpsProtocol
                };

                if (this.config.port !== this.config.securePort) {
                    this.instances[binding.key + '_redirect'] = {
                        https: false,
                        redirectTo: this.config.securePort,
                        localRedirectTo: this.config.localPort,
                        address: binding.address,
                        port: this.config.port,
                        noApi: true
                    };
                }
            }

            next();
        }
    ], (err) => {
        if (err) {
            logger.error(__('Failed to configure REST instances: %s',
                JSON.stringify(err, null, 4)));

            if (Object.keys(previousInstances).length > 0) {
                logger.warn(__('Restore previous settings'));
                this.instances = previousInstances;
            } else {
                logger.warn(__('Failover to localhost only configuration'));
                this.instances = {
                    local: this.instances.local
                };
            }
        }

        done();
    });
};

/**
 * Normalize method descriptor (validation and providing defaults).
 * Modifies mdesc in-place.
 */
function normalizeMdesc(mdesc, validate) {
    mdesc.schemas = mdesc.schemas || {};
    mdesc.async = (mdesc.action !== 'read') && mdesc.async;
    mdesc.deferredAsync = (mdesc.async && mdesc.deferredAsync);
    // Default advanced settings are empty
    mdesc.advanced = mdesc.advanced || {};
    if (validate) {
        [
            mdesc.schemas.input,
            mdesc.schemas.output,
            mdesc.schemas.url,
            mdesc.schemas.query
        ].forEach(function(s) {
            if (s) {
                var err = schemaUtils.validateSchema(s, mdesc.id);
                if (err) {
                    throw err;
                }
            }
        });
    }
    mdesc.parent = {};
    if (mdesc.attachTo) {
        mdesc.parent = {
            id: mdesc.attachTo.id,
            paramsMap: mdesc.attachTo.paramsMap
        };
        delete mdesc.attachTo;
    }
    if (!mdesc.children) {
        mdesc.children = [];
    }
}

/**
 * Call HTTP GET method for a parent resource.
 * This is used to verify that parent resources exist before
 * the request is dispatch to corresponding handler.
 *
 * @param {Object} subMdesc   Method descriptor for subrequest.
 * @param {String} srcUrl     Parametrized URL corresponding to origin request.
 * @param {Object} req        Request for the original resource.
 * @param {Object} paramsMap  Param mapping which should be used for the result.
 * @param {Array}  fields     Attributes of parent resource which should be
 *                            saved to request object.
 */
function subRequest(subMdesc, srcUrl, req, paramsMap, fields, done) {
    // Backup request context to restore it at the end. We use the same request
    // object for subrequest but provide different parameters for it.
    var backup = {
        metadata: req.metadata,
        params: req.params,
        query: req.query,
        body: req.body
    };
    paramsMap = paramsMap || {};
    fields = fields || [];
    req.metadata = {links: []};
    req.query = {};
    req.body = {};
    req.params = {};
    // Rename URL parameters from original request to names used in sub-request
    // and update paramsMap to reflect those implicit parameter mappings.
    var srcParams = restUtils.getUrlParameters(srcUrl);
    var subParams = restUtils.getUrlParameters(subMdesc.url);
    assert(srcParams.length >= subParams.length);
    for (var i in subParams) {
        req.params[subParams[i]] = backup.params[srcParams[i]];
        if (!paramsMap[subParams[i]]) {
            paramsMap[subParams[i]] = srcParams[i];
        }
    }
    // If not specified otherwise, we are interested only in key parameter (the
    // last parameter in URL) of parent resource
    var keyidx = subParams.length - 1;
    var key = subParams[keyidx];
    if (fields.indexOf(key) === -1) {
        req.query.fields = fields.concat([key]);
    } else {
        req.query.fields = fields;
    }

    subMdesc.handler(req, function(err, res) {
        // restore parameters in request object
        for (var p in backup) {
            req[p] = backup[p];
        }
        if (err || !res) {
            return done(err);
        }
        // rename parent's properties according to paramsMap
        var resRenamed = {};
        for (var p in res) {
            var newName = paramsMap[p] || p;
            resRenamed[newName] = res[p];

            // Update request parameters if the parameter is a key.
            //
            // NOTE: You might think that this is useless, but for example in
            // case of zfs pool URLs which accept GUID as alternative to pool
            // name, it will nicely translate GUID to pool name which can be
            // used by child URLs then.
            if (p === key) {
                req.params[newName] = res[p];
            }
        }
        done(undefined, resRenamed);
    });
}

/**
 * Load backend API. That actually means that we translate information
 * provided by backend to method descriptors (mdesc) which are later used
 * to register the methods with restify server.
 */
RestServer.prototype._loadApi = function(id, bend) {
    var self = this;

    if (self._extendedValidation) {
        restConvert.validateModuleDescriptor(bend);
    }

    var apimap = {
        name: bend.name,
        hideApi: bend.hideApi,
        methods: {},
        collections: {}
    };

    bend.handlers = bend.handlers || [];
    bend.handlers.forEach(function(mdesc) {
        if (self._extendedValidation) {
            restConvert.validateHandlerDescriptor(mdesc);
        }
        normalizeMdesc(mdesc, self._extendedValidation);

        var allowedZones = mdesc.allowedZones || ['global'];
        if (!utils.zoneIs(...allowedZones)) {
            return;
        }

        var m = apimap.methods[mdesc.id];
        if (!m) {
            m = {
                id: mdesc.id,
                versions: {}
            };
            apimap.methods[mdesc.id] = m;
        }
        if (mdesc.version) {
            // expand x.y to x.y.z where z is latest supported patch version
            var vers = new ApiVersion(mdesc.version);
            vers.expandToOrDie(self.versions);
            vers = vers.toString();
            m.versions[vers] = mdesc;
            mdesc.version = vers;
        } else {
            self.versions.forEach(v => {
                // default mdesc for all supported versions
                var vers = v.toString();
                if (!(vers in m.versions)) {
                    m.versions[vers] = _.cloneDeep(mdesc);
                    m.versions[vers].version = vers;
                }
            });
        }
    });

    bend.collections = bend.collections || [];
    bend.collections.forEach(function(cdesc) {
        var version;

        if (cdesc.version) {
            // expand x.y to x.y.z where z is latest supported patch version
            version = new ApiVersion(cdesc.version);
            version.expandToOrDie(self.versions);
            version = version.toString();
        }

        collection.genCollectionMethods(cdesc, self._extendedValidation)
            .forEach(function(mdesc) {
                var allowedZones = mdesc.allowedZones || ['global'];
                if (!utils.zoneIs(...allowedZones)) {
                    return;
                }

                var m = apimap.methods[mdesc.id];
                if (!m) {
                    m = {
                        id: mdesc.id,
                        url: mdesc.url,
                        action: mdesc.action,
                        hidden: mdesc.hidden,
                        versions: {}
                    };
                    apimap.methods[mdesc.id] = m;
                }
                if (version) {
                    m.versions[version] = mdesc;
                    mdesc.version = version;
                } else {
                    self.versions.forEach(v => {
                        // default mdesc for all supported versions
                        var vers = v.toString();
                        if (!(vers in m.versions)) {
                            m.versions[vers] = _.cloneDeep(mdesc);
                            m.versions[vers].version = vers;
                        }
                    });
                }
            });

        var c = apimap.collections[cdesc.id];
        if (!c) {
            c = {
                id: cdesc.id,
                versions: {}
            };
            apimap.collections[cdesc.id] = c;
        }
        if (version) {
            c.versions[version] = cdesc;
            cdesc.version = version;
        } else {
            self.versions.forEach(v => {
                // default mdesc for all supported versions
                var vers = v.toString();
                if (!(vers in c.versions)) {
                    c.versions[vers] = _.cloneDeep(cdesc);
                    c.versions[vers].version = vers;
                }
            });
        }
    });

    return apimap;
};

/**
 * Create restify route for a particular URL + method.
 *
 * @param {object} mdesc     Method object
 * @param {array}  handlers  Request handlers
 * @param {boolean} isRaw    If true then don't wrap provided handlers by
 *                           standard handlers and register them as they are
 *                           (this is a hack to support async jobs).
 */
RestServer.prototype._installRestifyHandlers = function(mdesc, handlers,
        isRaw, servId) {
    var url = mdesc.url;

    // If it is a proxy url convert it to regexp URL
    if (mdesc.urlProxy) {
        url = new RegExp('^' + url.split('/').map(function(comp) {
            return (comp[0] === ':') ? '([^/]+)' : comp;
        }).join('/') + '/(.+)$');
    }

    var meta = [{ // chain starts with meta info
        name: mdesc.id + '_v' + mdesc.version,
        path: url,
        version: mdesc.version
    }];
    if (!isRaw) {
        handlers = this._genRestifyChain(mdesc, handlers);
    }
    // handlers and route ID are saved for later use by async jobs
    mdesc._chain = handlers;

    var setupHandler = (serv, id) => {
        var routeId = serv[restUtils.mapHTTPMethod(mdesc.action).sys]
                                  .apply(serv, meta.concat(handlers));
        mdesc._routeId = mdesc._routeId || routeId;
    };

    if (servId) {
        setupHandler(this.getInstance(servId), servId);
    } else {
        this.forEachInstance(setupHandler);
    }
};

/**
 * Serve static content
 *
 * @param {object} server  server object
 * @param {string} url     URL path
 * @param {string} dir     module name (should end with path)
 * @private
 */
RestServer.prototype._registerStatic = function(server, url, dir) {
    var rexp = new RegExp('\\' + url + '\\/?.*');

    server.get(url, function(req, res) {
        res.header('Location', url + '/');
        res.send(302); // redirect /docs -> /docs/
    });

    server.get(rexp, restify.serveStatic({
        directory: dir,
        default: 'index.html'
    }));
};

RestServer.prototype._registerApiBackends = function(done) {
    var self = this;
    var colls = [];

    logger.debug(__('REST API backends to process: ' + self.bends.length));

    // register async job API
    self.bends.push(jobManager.jobManagerApi);

    // parse all backend descriptors
    self.bends.forEach(function(bend) {
        var bendId = restUtils.apiBackendUID(bend);

        // Check if this backend already has API map
        if (self.bendApiMap.hasOwnProperty(bendId)) {
            throw new Error('Duplicated backend definition: ' + bendId);
        }

        logger.debug(__('Loading API backend %s', bendId));
        self.bendApiMap[bendId] = self._loadApi(bendId, bend);
    });

    // build resource tree for each REST API version
    self.versions.forEach(v => {
        var tree = buildResourceTree(self.bendApiMap, v.toString());
        completeUrlParams(tree, []);
        completeParentFields(tree, {});
        //console.log('Tree for version ' + v + ':');
        //printTree(tree);
        self.trees[v] = tree;
    });

    // Now init all api that have initialize procedure
    async.each(self.bends.filter(function(b) {
        return b.initialize;
    }), function(bend, next) {
        logger.debug(__('Initializing backend: %s', bend.name));
        bend.initialize(self, function(err) {
            if (err) {
                logger.error(__(
                    'Error occurred during backend initialization: %s',
                    err.toString()));
                next(err);
                return;
            }
            logger.debug(__('REST Api %s successfully initialized',
                    bend.name));
            next();
        });
    }, done);
};

/**
 * The purpose of this function is to decouple processing of error from sending
 * it OTW, because for async request we want to log the error as soon as it
 * occurs, but sending should be defered to later time. We do:
 *
 * 1) Map NEF error to HTTP status code,
 * 2) save it to response object for later use by send,
 * 3) log the error and
 * 4) return response object with code and message.
 */
RestServer.prototype.processError = function(req, error) {
    var statusCode;

    assert(error instanceof Error);
    if (!(error instanceof NefError)) {
        error = NefError(error, __('Error when serving REST request'));
    }

    switch (error.code) {
        case 'ENOPROP':
        case 'EBADARG':
        case 'EINVAL':
            statusCode = 400; // Bad request
        break;
        case 'EAUTH':
            statusCode = 401; // Access forbidden
        break;
        case 'ELICENSE':
        case 'EACCES':
            statusCode = 403; // Access forbidden
        break;
        case 'ENOENT':
        case 'ENODEV':
        case 'ENXIO':
            statusCode = 404; // Not found
        break;
        case 'ETIMEDOUT':
            statusCode = 502; // Gateway Time-out
        break;
        default:
            statusCode = 500; // Internal server error
    }

    // log only internal errors (client errors only if running in verbose mode)
    if (this._debugMode || statusCode.toString()[0] === '5') {
        var stack = '';

        // be verbose in case of UNKNOWN error because they are generated for
        // server code errors.
        if (error.code === 'EUNKNOWN') {
            stack = '\n' + error.rootCause().stack;
        }
        logger.error(__('%(op)s %(path)s failed: %(err)s%(stack)s', {
            op: req.method,
            path: req.url,
            err: error.toString(),
            stack:  stack
        }));
    }

    return {
        statusCode: statusCode,
        error: error
    };
};

// Error fields to be removed in corresponding environments.
var errorEnvRemoval = {
    'production': ['stack', 'cxxinfo']
};

function filterError(err) {
    // In production environment some fields should not be returned to user.
    if (process.env.NEF_ENV in errorEnvRemoval) {
        errorEnvRemoval[process.env.NEF_ENV].forEach(function(f) {
            if (f in err) {
                delete err[f];
            }
        });

        if (err.cause) {
            err.cause = filterError(err.cause);
        }

    }

    return err;
}

/**
 * Process error and send it to client.
 */
RestServer.prototype.sendError = function(req, res, error) {
    var stat = this.processError(req, error);
    res.statusCode = req.responseStatus || stat.statusCode;
    res.json(_escapeResult(req, filterError(stat.error.serialize())));
};

/**
 * Check type of input keys and input payload, convert them as necessary and
 * route to next handler if no error.
 */
RestServer.prototype._validateRequest = function(req, res, mdesc, next) {
    try {
        restConvert.validateUrlParams(req.params, mdesc.schemas.url);
        restConvert.validateQueryParams(req.query, mdesc.schemas.query);
        restConvert.validateBody(req.body, mdesc.schemas.input);
    } catch (error) {
        if (!(error instanceof NefError)) {
            throw error;
        }
        this.sendError(req, res, error);
        return next(false);
    }
    next();
};

/**
 * User provided handlers cannot be used directly as restify handlers.
 * Hence this function which constitutes a bridge between restify and backend
 * handlers.
 *
 * NOTE: The returned chain of handlers has support for async requests (202
 * status).
 */
RestServer.prototype._wrapUserHandler = function(mdesc) {
    var self = this;

    assert(mdesc.handler, 'Handler for ' + mdesc.id + ' is not defined');

    /*
     * Handles sync request including sync replies to async job status.
     */
    function syncWrapper(req, res, next) {
        mdesc.handler(req, function(err, handlerRes) {
            if (err) {
                if (err.logged) {
                    // async reply - error has been already processed
                    assert(err instanceof NefError);
                    res.statusCode = req.responseStatus;
                    res.json(err.serialize());
                } else {
                    // process and send the error to client
                    self.sendError(req, res, err);
                }
                return next(false); // Stop request chaining
            }

            assert(!handlerRes || typeof handlerRes === 'object',
                'Returned value from handler is neither object nor array');

            req.result = handlerRes;
            next(); // chain to next handler
        });
    }

    /*
     * Handles async request (202 status) ... restify hackery
     */
    function asyncWrapper(req, res, next) {
        // Following three vars are initialized only if async job is created.
        // The idea is to run async only if needed. If done callback returns
        // before async job is initialized we simply return the result in a
        // sync way.
        var job;
        var statusMdesc;
        var asyncJobRoute; // either status or result route for the job

        // initialize async job vars
        function createAsyncJob() {
            job = jobManager.createAsyncJob(req, function() {
                self.forEachInstance((serv) => {
                    serv.rm(asyncJobRoute);
                });
            });
            statusMdesc = job.genStatusMdesc();
            var handlers = self._wrapUserHandler(statusMdesc);
            self._installRestifyHandlers(statusMdesc, handlers);
            asyncJobRoute = statusMdesc._routeId;
        }

        mdesc.handler(req, function(err, handlerRes) {
            if (job) {
                // the job has finished, rm status route and add result route
                var resultMdesc = job.genResultMdesc();
                // we need the first half of the chain to be the same as for
                // "get status" method and the second half to be the same as for
                // original request. Request context will be restored in the middle
                var chain = [];
                for (var h in statusMdesc._chain) {
                    if (statusMdesc._chain[h].name === 'syncWrapper') {
                        break;
                    }
                    chain.push(statusMdesc._chain[h]);
                }
                chain = chain.concat(self._wrapUserHandler(resultMdesc));
                for (var h in mdesc._chain) {
                    if (mdesc._chain[h].name === 'asyncWrapper') {
                        chain = chain.concat(
                                mdesc._chain.slice(parseInt(h) + 1));
                        break;
                    }
                }
                self.forEachInstance((serv, id) => {
                    serv.rm(statusMdesc._routeId);
                });
                self._installRestifyHandlers(resultMdesc, chain, true);
                asyncJobRoute = resultMdesc._routeId;

                // Process error in order to log it at the time when it occurs
                // rather than when it is retrieved by client.
                if (err) {
                    stat = self.processError(req, err);
                    req.responseStatus = stat.statusCode;
                    err = stat.error;
                    err.logged = true;
                }
                job.done(err, handlerRes);
            } else {
                if (err) {
                    // process and send the error to client
                    self.sendError(req, res, err);
                    return next(false); // Stop request chaining
                }

                assert(!handlerRes || typeof handlerRes === 'object',
                    'Returned value from handler is neither object nor array');

                req.result = handlerRes;
                next(); // chain to next handler
            }
        }, function(processed, description, total) {
            if (!mdesc.deferredAsync && !job) {
                createAsyncJob();
                job.redirectToMonitor(req, res, next);
                // redirect takes care of terminating the chain
            } else {
                assert(job, 'Progress cb was called before 202 reply');
            }
            job.setProgress(processed, description, total);
        }, function(handlerRes) {
            if (mdesc.deferredAsync) {
                assert(!job);
                createAsyncJob();
                job.redirectToMonitor(req, res, handlerRes, next);
                // redirect takes care of terminating the chain
            }
        });

        // job could have been created by calling progressCb synchronously
        if (!mdesc.deferredAsync && !job) {
            createAsyncJob();
            job.redirectToMonitor(req, res, next);
            // redirect takes care of terminating the chain
        }
    };

    if (mdesc.async) {
        return [asyncWrapper];
    } else {
        return [syncWrapper];
    }
};

/*
 * Perform HTML escape for every string member of the object given.
 */
function _escapeResult(req, result) {
    var flags = req.serverParams;

    function _escapeItem(o) {
        if (o !== null) {
            if (utils.isArray(o)) {
                for (var i = 0; i < o.length; i++) {
                    o[i] = _escapeItem(o[i]);
                }
            } else if (typeof(o) === 'object') {
                Object.keys(o).forEach(function(k) {
                    o[k] = _escapeItem(o[k]);
                });
            } else if (typeof(o) === 'string') {
                o = escapeHtml(o);
            }
        }
        return o;
    }

    // Local clients (i.e. CLI) are always not escaped.
    if (flags.escapeHtml) {
        return _escapeItem(result);
    } else {
        return result;
    }
}

/*
 * Transform JSON response before returning it to user.
 * Generic function for final processing of the response.
 */
RestServer.prototype._xformResponse = function(req) {
    // Apply HTML escaping.
    if (req.result) {
        req.result = _escapeResult(req, req.result);
    }
};

/**
 * Wrap backend API handlers by common handlers needed for processing a
 * request. Result is a pipeline of functions where each function does
 * well defined thing.
 *
 * Depending on stage of processing, following custom properties of "req"
 * can be used by handlers:
 *
 *  req.body :    Parsed JSON request payload
 *  req.metadata: Meta-data which should be merged to final response
 *
 * API interface version is also handled here. Backend version overrides server
 * version.
 *
 * NOTE: avoid pushing anonymous functions to the chain of handlers (pipeline)
 * so that they can be easily identified by dtrace.
 *
 * @param {object} mdesc    Method descriptor.
 * @param {array}  handlers Handlers to serve the request.
 */
RestServer.prototype._genRestifyChain = function(mdesc, handlers) {
    var self = this;
    var methname = mdesc.id;
    var chain = [];

    // Inject plugins middleware
    if (self._beforeAll.length) {
        self._beforeAll.forEach(function(handler) {
            chain.push(function middlewarePlugins(req, res, next) {
                handler(req, res, mdesc, next);
            });
        });
    }

    // Input validation and meta-data initialization go first
    chain.push(function validateInput(req, res, next) {
        var proxyPath;

        // convert parameters from proxy URLs (with regexp) to normal parameters
        if (mdesc.urlProxy) {
            var paramNames = restUtils.getUrlParameters(mdesc.url);
            var params = {};

            for (var i in req.params) {
                if (paramNames[i]) {
                    params[paramNames[i]] = req.params[i];
                } else {
                    proxyPath = req.params[i]; // should be the last parameter
                }
            }
            req.params = params;
        }
        // Avoid unhandled exceptions when validating & referencing optional
        // body args.
        if (!req.body && ['POST', 'PUT'].indexOf(req.method) !== -1) {
            req.body = {};
        }
        self._validateRequest(req, res, mdesc, function(arg) {
            req.metadata = {links: []};
            req.responseHeaders = {};
            // fields is universally recognized query parameter
            req.query.fields = restUtils.getRequestFields(req);
            // proxy path parameter (if there is any) must be added after
            // validation because it is not in url schema
            if (proxyPath) {
                req.params.proxyPath = proxyPath;
            }
            next(arg);
        });
    });

    // Resolve parent objects and map parameter names from them into the
    // current request
    var parentStack = [mdesc];
    var node = mdesc;
    while (node = node.parent.mdesc) {
        // Parent must not come from the same collection (to avoid checking
        // parents for special actions on collections)
        if (!node.skipParentCheck &&
                node.collectionId !== mdesc.collectionId &&
                node.isCollectionEntry) {
            parentStack.splice(0, 0, node);
        }
    }

    // insert parent check handler into chain if not disabled
    if (parentStack.length > 0) {
        chain.push(function resolveParents(req, res, next) {
            req.parents = {}; // for saving results of parent queries

            async.timesSeries(parentStack.length - 1, function(i, next) {
                subRequest(parentStack[i], mdesc.url, req,
                        parentStack[i + 1].parent.paramsMap,
                        mdesc.parentFields[parentStack[i].id],
                        function(err, res) {
                    if (!err) {
                        // Save result on parent for possible use by child
                        // resource handler
                        req.parents[parentStack[i].id] = res;
                    }
                    next(err);
                });
            }, function(err) {
                if (err) {
                    self.sendError(req, res, err);
                    return next(false);
                }
                next();
            });
        });
    }

    // Chain provided request handlers in the middle of the chain
    handlers.forEach(function(h) {
        chain.push(h);
    });

    // Filter output fields
    if (mdesc.action === 'read') {
        chain.push(function filterFields(req, res, next) {
            if (req.result && req.query.fields) {
                restUtils.filterFields(req.result, req.query.fields);
            }
            next();
        });
    }

    // Validate output according to the schema if in debug mode
    if (self._extendedValidation &&
        !mdesc.disableOutputValidation) {
        chain.push(function validateOutput(req, res, next) {
            var outputSchema = mdesc.schemas && mdesc.schemas.output;
            try {
                restConvert.validateReply(req.result, outputSchema,
                        req.query.fields);
            } catch (error) {
                self.sendError(req, res, error);
                return next(false);
            }
            next();
        });
    }

    /*
     * Add meta data which can be added when operating in scope of a single
     * method (not considering collection meta data)
     */
    if (mdesc.action === 'read' && !mdesc.noMetadata) {
        chain.push(function addMetadata(req, res, next) {
            if (utils.isArray(req.result)) {
                req.result = {
                    data: req.result
                };
            } else {
                // be safe and don't modify object passed from handler
                req.result = utils.objectCopy(req.result);
            }
            req.metadata.links.push({
                rel: 'self',
                href: req.url
            });
            // generate parent link only if this is not top-level resource
            if (mdesc.parent.mdesc && mdesc.parent.mdesc.id !== 'root') {
                // collection link overrides parent link
                if (!req.metadata.links.some(function(l) {
                    return (l.rel === 'collection');
                })) {
                    req.metadata.links.push({
                        rel: 'parent',
                        href: restUtils.parentUrl(mdesc.parent.mdesc.url,
                                req.getPath())
                    });
                }
            }
            mdesc.children.forEach(function(ch) {
                var url = restUtils.childUrl(req.getPath(), ch.url);
                // skip URLs with unexpanded parameters
                if (url.indexOf(':') === -1) {
                    req.metadata.links.push({
                        rel: ch.parent.rel,
                        method: restUtils.mapHTTPMethod(ch.action).usr,
                        href: url
                    });
                }
            });
            for (var p in req.metadata) {
                if (req.result[p] !== undefined) {
                    logger.warn(__('Metadata and data clash for property ' +
                            '"%s" in "%s"', p, mdesc.id));
                } else {
                    req.result[p] = req.metadata[p];
                }
            }
            next();
        });
    }

    // Inject plugins middleware
    if (self._afterAll.length) {
        self._afterAll.forEach(function(handler) {
            chain.push(function(req, res, next) {
                handler(req, res, mdesc, next);
            });
        });
    }

    chain.push(function finalStep(req, res, next) {
        if (req.responseStatus) {
            res.statusCode = req.responseStatus;
        } else {
            res.statusCode = 200; // default status
        }

        for (var h in req.responseHeaders) {
            res.setHeader(h, req.responseHeaders[h]);
        }

        // avoid sending empty object
        if (typeof req.result === 'object' &&
            req.result !== null &&
            Object.keys(req.result).length === 0) {
            req.result = null;
        }

        // Perform HTML escaping.
        self._xformResponse(req);

        res.json(res.statusCode, req.result);
        next(false);
    });

    return chain;
};

/**
 * Construct a tree from registered URLs. Parts of the tree has been already
 * constructed in collection method generator. Now we need to bind remaining
 * pieces together. The tree is constructed based on either URLs (parent URL
 * is prefix of child URL) or explicit parent ID specifications in method
 * descriptors.
 *
 * Each node in tree has following members:
 *
 *   parent (mdesc object)
 *   array of children
 *
 * Each child has a "rel" and "mdesc" attrs. rels can be as follows:
 *
 *   subcollection
 *   action/* (actions in collection)
 *   child (general type for everything else)
 */
function buildResourceTree(bendApi, version) {
    var mdescs = {}; // all API methods
    var root = {
        id: 'root',
        action: 'read',
        url: '/',
        version: version,
        description: 'Get list of top-level REST resources',
        schemas: {
            output: {
                type: 'object',
                additionalProperties: false,
                properties: {} // we might want to put version here
            }
        },
        handler: function(req, done) {
            return utils.callAsync(done, null, {});
        },
        parent: {},
        children: []
    };

    // construct list of all methods
    for (var b in bendApi) {
        for (var m in bendApi[b].methods) {
            var mdesc = bendApi[b].methods[m].versions[version];
            if (mdesc) {
                assert(!mdescs[m], 'Duplicated definition of method ' + m +
                        ' in API version ' + version);
                mdescs[m] = mdesc;
            }
        }
    }

    // 1th pass - link parents specified by their ID to their children
    for (var id in mdescs) {
        var mdesc = mdescs[id];

        // lookup parent mdesc based on ID
        if (mdesc.parent.id && !mdesc.parent.mdesc) {
            assert(mdesc.url[0] !== '/', 'URL for ' + id +
                    ' must be parent relative');

            for (var i in mdescs) {
                if (i === mdesc.parent.id && mdescs[i].action === 'read') {
                    mdesc.parent.mdesc = mdescs[i];
                    break;
                }
            }
            assert(mdesc.parent.mdesc, 'Parent resource "' + mdesc.parent.id +
                    '" of method ' + id + ' does not exist');
        }
    }

    // 2nd pass - extend relative to absolute URLs
    for (var id in mdescs) {
        var mdesc = mdescs[id];

        if (mdesc.url[0] !== '/') {
            var node = mdesc;
            var paramsMap = utils.objectCopy(mdesc.parent.paramsMap || {});
            while (mdesc.url[0] !== '/') {
                node = node.parent.mdesc;
                // rename URL parameters in parent URL if requested
                var comps = node.url.split('/');
                for (var i in comps) {
                    if (comps[i][0] === ':') {
                        var newName = paramsMap[comps[i].slice(1)];
                        if (newName) {
                            delete paramsMap[comps[i].slice(1)];
                            comps[i] = ':' + newName;
                        }
                    }
                }
                if (mdesc.url) {
                    comps.push(mdesc.url);
                }
                mdesc.url = comps.join('/');
                if (node.parent.paramsMap) {
                    utils.extend(paramsMap, node.parent.paramsMap);
                }
            }
        }
    }

    // 3rd pass - create implicit parent-child links.
    for (var id in mdescs) {
        var mdesc = mdescs[id];
        var url = mdesc.url;

        // lookup parent's method descriptor if not known by matching URLs
        if (!mdesc.parent.mdesc) {
            assert(mdesc.url[0] === '/', 'URL for ' + id + ' must be absolute');
            var parent = null;
            while ((url = url.slice(0, url.lastIndexOf('/'))) && !parent) {
                for (var i in mdescs) {
                    if (i !== id && mdescs[i].action === 'read' &&
                            restUtils.matchUrls(url, mdescs[i].url)) {
                        parent = mdescs[i];
                        break;
                    }
                }
            }
            mdesc.parent.mdesc = parent || root;
        }

        // set default type of relation if unspecified
        if (!mdesc.parent.rel) {
            mdesc.parent.rel = (mdesc.isCollection) ?
                    'collection/' + mdesc.id : 'child';
        }
        mdesc.parent.mdesc.children.push(mdesc);
    }

    return root;
}

/**
 * Depth-first search in URL tree completing missing URL parameters in URL
 * schemas from parent URL schemas.
 *
 * Note that we cannot lookup parameters by name in parent schemas because
 * the name in parent may be different. Instead we need to lookup parameters
 * by their position in URL.
 */
function completeUrlParams(mdesc, schemaStack) {
    var paramNames = restUtils.getUrlParameters(mdesc.url);
    var paramSchema = {}; // URL parameters defined in this mdesc

    if (!mdesc.schemas.url) {
        mdesc.schemas.url = {
            type: 'object',
            additionalProperties: false,
            properties: {}
        };
    }
    var properties = mdesc.schemas.url.properties;

    // lookup schema for all params
    for (var i = 0; i < paramNames.length; i++) {
        var name = paramNames[i];
        var typeDef;

        if (name in properties) {
            paramSchema[i] = properties[name];
            continue;
        }
        for (var j = schemaStack.length - 1; j >= 0; j--) {
            typeDef = schemaStack[j][i];
            if (typeDef) {
                break;
            }
        }
        assert(typeDef, 'Missing typedef of URL parameter "' + name + '" in ' +
                mdesc.url);
        properties[name] = typeDef;
    }

    // make parameters defined at this level known to children
    schemaStack.push(paramSchema);
    mdesc.children.forEach(function(ch) {
        completeUrlParams(ch, schemaStack);
    });
    schemaStack.pop();
}

/**
 * For parent check we need to know which fields from parent resource should be
 * retrieved when doing the check. In case of multiple parent levels we need to
 * accumulate for given URL all fields from root of resource tree up to the
 * resource which we are doing the check for.
 */
function completeParentFields(mdesc, parentFields) {

    if (mdesc.parentFields && Object.keys(mdesc.parentFields).length > 0) {
        for (var k in parentFields) {
            if (mdesc.parentFields[k]) {
                parentFields[k].forEach(function(f) {
                    if (mdesc.parentFields[k].indexOf(f) === -1) {
                        mdesc.parentFields[k].push(f);
                    }
                });
            } else {
                mdesc.parentFields[k] = parentFields[k];
            }
        }
    } else {
        mdesc.parentFields = parentFields;
    }

    // pass current parentFields to children
    mdesc.children.forEach(function(ch) {
        completeParentFields(ch, mdesc.parentFields);
    });
}

/**
 * Walk REST resource tree (depth-first) calling provided callback for each
 * node.
 */
function walkResourceTree(root, cb, done) {
    var workingSet = [root];

    async.whilst(
        () => {return workingSet.length > 0;},
        (next) => {
            let node = workingSet.pop();
            cb(node, (err) => {
                if (err) {
                    return next(err);
                }
                node.children.forEach((ch) => {
                    workingSet.push(ch);
                });
                process.nextTick(next);
            });
        },
        done
    );
}

/**
 * Debug routine to print the whole resource tree.
 */
function printTree(mdesc, level) {
    level = level || 0;
    for (var i = 0; i < level; i++) {
        process.stdout.write('  ');
    }
    process.stdout.write(mdesc.url + ' (' + mdesc.action + ')\n');
    for (var i = 0; i < mdesc.children.length; i++) {
        printTree(mdesc.children[i], level + 1);
    }
}

function quoteIpv6(addr) {
    if (addr.indexOf(':') !== -1 &&
        addr.indexOf('[') === -1 &&
        addr.indexOf(']') === -1) {
        return '[' + addr + ']';
    } else {
        return addr;
    }
}

function getConfigHash(conf) {
    return JSON.stringify(conf);
}

/**
 * Map management address which can be IP or interface name to IP address.
 * In case of IP try to find such network address.
 */
function selectInterface(addr) {
    assert(addr);

    if (utils.isAllZeroesAddress(addr)) {
        return addr;
    }

    // check management ip
    var ifaces = os.networkInterfaces();

    for (var iface in ifaces) {
        // address specified by interface
        if (iface === addr) {
            var found;

            for (var i in ifaces[iface]) {
                var addrObj = ifaces[iface][i];

                // prefer IPv4 address over IPv6
                if (addrObj.family === 'IPv4') {
                    found = addrObj.address;
                } else if (!found) {
                    found = addrObj.address;
                }
            }
            if (!found) {
                throw new NefError('EINVAL', __('No address found ' +
                        'for management interface %s', addr));
            }
            return found;
        }

        for (var i in ifaces[iface]) {
            var addrObj = ifaces[iface][i];

            if (addrObj.address === addr) {
                return addr;
            }
        }
    }
    throw new NefError('EINVAL', __('Management address or interface ' +
            '%s not found', addr));
}

function decodeVersion(req, serverVersions) {
    var version = req.headers['accept-version'];

    var groups = req.url.match(RegExp('^\/v([\.0-9]+)(\/.*)'));
    if (groups) {
        req.url = groups[2];
        version = version || groups[1];
    }

    // Cleanup headers, so it won't trigger restify handler
    delete req.headers['accept-version'];
    // We always support only one major version, so by default we assume it
    return new ApiVersion(version || serverVersions[0].major + '.0');
}

module.exports = RestServer;
module.exports.buildResourceTree = buildResourceTree;
module.exports.completeUrlParams = completeUrlParams;
