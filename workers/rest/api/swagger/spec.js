/** @FileOverview Swagger 1.2 spec schemas
 * Copyright (C) 2014  Nexenta Systems, Inc
 * All rights reserved.
 */

var spec = {};
spec.version = '1.2';

spec.resourceListing = function(apis) {
    return {
        swaggerVersion: spec.version,
        basePath: '',
        apis: apis
    };
};

spec.resourceObject = function(path, description) {
    return {
        path: path,
        description: description
    };
};

spec.apiDeclaration = function(models, apis, version) {
    return {
        swaggerVersion: spec.version,
        apiVersion: version,
        authorizations: {},
        models: models,
        produces: ['application/json'],
        consumes: ['application/json', 'application/x-www-form-urlencoded'],
        apis: apis
    };
};

spec.apiObject = function(path, operations) {
    return {
        path: path,
        operations: operations
    };
};

spec.operationObject = function(summary, nickname, method,
                                 parameters, responseMessages,
                                 ret, notes, async) {
    return {
        summary: summary,
        nickname: async ? 'Async_' + nickname : nickname,
        method: method,
        parameters: parameters,
        responseMessages: responseMessages,
        type: ret,
        notes: notes || summary
    };
};

spec.parameterObject = function(name, dataType, description,
                                 defaultValue, paramType, enumVal,
                                 required, shortName, formatter, unencoded) {
    return {
        description: description,
        defaultValue: defaultValue,
        type: dataType,
        name: name,
        paramType: paramType,
        enum: enumVal,
        required: required,
        shortName: shortName,
        formatter: formatter,
        unencoded: !!unencoded
    };
};

spec.errorModel = function() {
    return {
        id: 'ErrorModel',
        properties: {
            code: {
                type: 'string',
                description: 'Error code',
                required: true
            },
            message: {
                type: 'string',
                description: 'Error message',
                required: true
            },
            stack: {
                type: 'string',
                description: 'Optional stack trace',
                required: false
            }
        }
    };
};

module.exports = spec;
