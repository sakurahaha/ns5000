/*
 * REST API backend for swagger REST api report.
 *
 * Copyright (C) 2014 Nexenta Systems, Inc
 * All rights reserved.
 *
 */

var NefError = require('nef/error').NefError;
var logger = require('nef/logger');
var restUtils = require('nef/restUtils.js');
var Swagger = require('./swagger.js');

var swagger;

function listingHandler(req, done) {
    var spec;

    try {
        spec = swagger.getSpec(req, req.apiVersion.toString());
    } catch (err) {
        done(err);
        return;
    }
    done(undefined, spec);
}

function apiHandler(req, done) {
    var schema = swagger.getSchema(req.params.api, req.apiVersion.toString());

    if (!schema) {
        done(NefError('ENOENT', __('No such API: %s', req.params.api)));
    } else {
        done(undefined, schema);
    }
}

function initApi(restServer, done) {
    swagger = new Swagger(restServer);
    done();
}

module.exports = {
    name: 'Swagger API',
    initialize: initApi,
    collections: [],
    handlers: [{
        id: 'resourceListing',
        handler: listingHandler,
        async: false,
        noMetadata: true,
        action: 'read',
        url: '/api-docs',
        description: 'Get swagger schema for all REST API',
        allowedZones: ['global', 'non-global'],
        schemas: {
            output: {type: 'object'} // opaque object in swagger format
        },
        accessLevel: 'guest',
    }, {
        id: 'swaggerResource',
        handler: apiHandler,
        action: 'read',
        noMetadata: true,
        url: '/api-docs/:api',
        description: 'Get swagger schema for all REST API',
        allowedZones: ['global', 'non-global'],
        schemas: {
            url: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    api: {type: 'string', required: true}
                }
            },
            output: {type: 'object'} // opaque object in swagger format
        },
        accessLevel: 'guest',
    }]
};
