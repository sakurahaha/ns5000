/**
 * @FileOverview Swagger support for NEF REST API
 *
 *  Swagger is a specification and a set of tools to describe and
 *  document RESTful APIs. This code is intended to generate swagger
 *  description for NEF REST API using introspection.
 *
 *  Current implementation is for version 1.2 of swagger spec:
 *  https://github.com/wordnik/swagger-spec/blob/master/versions/1.2.md
 *
 *  Copyright (C) 2014-2016 Nexenta Systems, Inc
 *  All rights reserved.
 **/

var log = require('nef/logger');
var Resource = require('./resource.js');
var spec = require('./spec.js');
var worker = require('nef/baseWorker');
var NefError = require('nef/error').NefError;

/**
 * Create swagger object
 *
 * @param {object} restServer  restify object
 * @param {string} docPath     path for swagger metadata
 * @constructor
 */
var Swagger = function(restServer, docPath) {
    var self = this;

    self.docPath = docPath || 'api-docs/';

    // create swagger spec for each supported version
    self.versions = {};
    restServer.versions.forEach(v => {
        self.versions[v.toString()] = {
            version: v.toString(),
            paths: {},
            resources: [],
            spec: {}
        };
    });

    for (var v in self.versions) {
        self.versions[v].spec = self.createSpec(spec.version, restServer,
                    self.versions[v].version);
        self.getSpec(null, v);
        for (var path in self.versions[v].paths) {
            self.getSchema(path, v);
        }
    }
};

/**
 * Read REST server backend API map and create swagger metadata
 *
 * @param {string} version     version of swagger spec
 * @param {object} restServer  restify server object (should have 'bendApiMap')
 * @param {string} apiVersion  version of API to generate spec for
 */
Swagger.prototype.createSpec = function(version, restServer, apiVersion) {
    var self = this;

    if (!restServer || !restServer.bendApiMap) {
        log.error(__('swagger: invalid restify object.'));
        return;
    }

    if (version == spec.version) {
        for (var api in restServer.bendApiMap) {
            self.addResource(restServer.bendApiMap[api], apiVersion);
        }

    } else {
        log.error(__('swagger: unsupported spec version %s, ' +
                'we support %s.', version, spec.version));
        return;
    }
};

/**
 * Add resource representation to swagger resources and build path map
 *
 * @param {object} restApi     restify API object
 * @param {string} apiVersion  filter resource based on this version
 */
Swagger.prototype.addResource = function(restApi, apiVersion) {
    var self = this;
    var path = basePath(restApi, apiVersion);

    // skip hidden API
    if (restApi.hideApi) {
        return;
    }

    // skip swagger and /api-docs endpoints
    if (!path || path == '/' || path.indexOf('api-docs') > -1) {
        return;
    }

    var resource = new Resource(restApi, apiVersion);

    self.versions[apiVersion].resources.push(resource);
    if (!self.versions[apiVersion].paths[path]) {
        self.versions[apiVersion].paths[path] = resource;
    } else {
        self.versions[apiVersion].paths[path].mergeResource(resource);
    }
};

/**
 * Get swagger specification (resource map)
 *
 * @returns {*}
 */
Swagger.prototype.getSpec = function(req, v) {
    var self = this;

    if (!(v in self.versions)) {
        throw new NefError('ENOENT', __('Requesting unsupported version %s ' +
                'of API specification', v));
    }

    if (!self.versions[v].cachedSpec) {

        var createIndex = function(path) {
            var docPath = self.docPath + path;
            var description = self.versions[v].paths[path].name;
            return spec.resourceObject(docPath, description);
        };

        var apis = Object.keys(self.versions[v].paths).map(createIndex);

        // Make sure Swagger top-level URLs are alphabetically sorted.
        apis.sort((a, b) => {
            if (a.path > b.path) {
                return 1;
            } else if (a.path < b.path) {
                return -1;
            } else {
                return 0;
            }
        });

        self.versions[v].cachedSpec = spec.resourceListing(apis);
        self.versions[v].cachedSpec.apiVersion = v;
    }

    if (req) {
        var protocol = req.connection.encrypted ? 'https://' : 'http://';
        self.versions[v].cachedSpec.basePath = protocol + req.headers.host +
                '/';
    }

    return self.versions[v].cachedSpec;
};

/**
 * Get swagger resource schema
 *
 * @param {object} api
 * @returns {*}
 */
Swagger.prototype.getSchema = function(api, v) {
    if (!(v in this.versions)) {
        return undefined;
    }
    var api = this.versions[v].paths[api];
    return (api) ? api.schema() : undefined;
};

/**
 * Get base path for restify API
 *
 * @param {object} api restify API object
 * @returns {*}
 */
var basePath = function(api, version) {
    var nonEmpty = function(x) {
        return x;
    };

    api = api.methods;
    if (!api) {
        return;
    }

    for (var id in api) {
        for (var v in api[id].versions) {
            if (v === version) {
                var url = api[id].versions[v].url;
                if (url) {
                    var path = url.split('/').filter(nonEmpty);
                    return path[0];
                }
            }
        }
    }
};

module.exports = Swagger;
