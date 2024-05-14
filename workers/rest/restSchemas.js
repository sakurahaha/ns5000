/*
 * JSON schemes for the REST server worker.
 *
 * Copyright (C) 2014 Nexenta Systems, Inc
 * All rights reserved.
 *
 */

var utils = require('nef/schemaUtils');

var schemas = {
    nullInput: utils.common.nullInput
};

var actionDesc = {
    description: 'Description of the action on URL',
    type: 'string',
};

var urlDesc = {
    type: 'object',
    description: 'Available methods for URL and their description',
    properties: {
        'GET': actionDesc,
        'PUT': actionDesc,
        'POST': actionDesc,
        'DELETE': actionDesc,
        'HEAD': actionDesc
    },
    additionalProperties: false
};

schemas.restUrl = {
    type: 'object',
    description: 'Description of relative URLs constituting REST interface ' +
        'of atomic node',
    patternProperties: {
        '^/(.+[^/])?$': urlDesc
    },
    additionalProperties: false
};

module.exports = schemas;
