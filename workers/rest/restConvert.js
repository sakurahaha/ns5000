/*
 * REST API schema validation and type convertor.
 *
 * Copyright (C) 2014-2016 Nexenta Systems, Inc
 * All rights reserved.
 *
 */

var assert = require('assert');
var NefError = require('nef/error').NefError;
var utils = require('nef/utils');
var schemaUtils = require('nef/schemaUtils');

var convert = {}; // exported stuff

/*
 * JSON schemas for module, handler and collection descriptor.
 * NOTE: No default values as the descriptors are validated only in debug mode.
 */

// generic JSON schema defining object type with properties. We don't accept
// just any JSON object schema, hence we need to restrict it a little bit.
var objectSchema = {
    type: 'object',
    properties: {
        type: {type: 'string', required: 'true', enum: ['object']},
        properties: {type: 'object', required: 'true'},
        additionalProperties: {type: 'boolean'}
    }
};

var objectSchemaOrNull = {
    oneOf: [{type: 'null'}, objectSchema]
};

// attachTo schema shared by collection and handler descriptor
var attachSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: {
            type: 'string',
            pattern: '^[a-zA-Z0-9_]+$',
            required: true
        },
        paramsMap: {
            type: 'object',
            additionalProperties: {
                type: 'string'
            }
        }
    }
};

// parentFields schema shared by collection and handler descriptor
var parentFieldsSchema = {
    type: 'object',
    additionalProperties: {
        type: 'array',
        items: {
            type: 'string'
        }
    }
};

// Advanced properties schema shared by collection and handler descriptor.
// It can be used to deliver custom settings of specific endpoint to
// rest plugins or endpoint handler
var advancedSchema = {
    type: 'object',
    additionalProperties: true
};

// Allowed zones restriction. One of: global, non-global, <zone-name>
var allowedZones = {
    type: 'array',
    required: false,
    items: {
        type: 'string'
    }
};

// module descriptor
var moduleDescriptorSchema = {
    type: 'object',
    properties: {
        name: {
            type: 'string',
            required: true
        },
        hideApi: {
            type: 'boolean',
            required: false
        },
        initialize: {
            type: 'any' // this is a function
        },
        collections: {
            type: 'array',
            items: {
                type: 'object'
            }
        },
        handlers: {
            type: 'array',
            items: {
                type: 'object'
            }
        }
    },
    additionalProperties: false,
};

// handler descriptor
var handlerDescriptorSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: {
            type: 'string',
            required: true,
            pattern: '^[a-zA-Z0-9_]+$'
        },
        version: {
            type: 'string',
            pattern: '^[0-9]+\.[0-9]+$'
        },
        attachTo: attachSchema,
        parentFields: parentFieldsSchema,
        advanced: advancedSchema,
        allowedZones: allowedZones,
        skipParentCheck: {
            type: 'boolean'
        },
        action: {
            type: 'string',
            required: true,
            enum: ['read', 'create', 'update', 'delete', 'head']
        },
        url: {
            type: 'string',
            required: true,
            pattern: '^[/:a-zA-Z0-9-]+$'
        },
        description: {
            type: 'string',
            required: true
        },
        handler: {
            type: 'any', // this is a function
            required: true
        },
        schemas: {
            type: 'object',
            properties: {
                input: objectSchemaOrNull,
                query: objectSchemaOrNull,
                url: objectSchemaOrNull,
                output: objectSchemaOrNull
            },
            additionalProperties: false
        },
        async: {
            type: 'boolean'
        },
        deferredAsync: {
            type: 'boolean'
        },
        noMetadata: {
            type: 'boolean'
        },
        urlProxy: {
            type: 'boolean'
        },
        notes: {
            type: 'string'
        },
        /**
         * disableOutputValidation option should used only
         * if you're experiencing problems with output validation.
         * For example: validation can take a long time if response
         * object is too big
         */
        disableOutputValidation: {
            type: 'boolean'
        },
        accessLevel: {
            type: 'string',
            enum: [
                'guest',
                'none',
                'viewer',
                'user',
                'admin',
                'root'
            ]
        }
    }
};

// collection descriptor
var collectionDescriptorSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: {
            type: 'string',
            required: true,
            pattern: '^[a-zA-Z0-9_]+$'
        },
        version: {
            type: 'string',
            pattern: '^[0-9]+\.[0-9]+$'
        },
        attachTo: attachSchema,
        parentFields: parentFieldsSchema,
        advanced: advancedSchema,
        allowedZones: schemaUtils.withDefault(allowedZones, ['global']),
        skipParentCheck: {
            type: 'boolean'
        },
        url: {
            type: 'string',
            required: true,
            pattern: '^[/:a-zA-Z0-9-]+$'
        },
        key: {
            type: 'string',
            required: true
        },
        objectName: {
            type: 'string',
            required: true
        },
        objectSchema: schemaUtils.required(objectSchema),
        querySchema: objectSchema,
        description: {
            type: 'string'
        },
        notes: {
            type: 'string'
        },
        asyncMethods: {
            type: 'boolean'
        },
        handler: {
            type: 'any'  // optional read collection function
        },
        methods: {
            type: 'any', // for validating method we have a separate schema
            required: true
        },
        accessLevel: {
            type: 'string',
            enum: [
                'guest',
                'none',
                'viewer',
                'user',
                'admin',
                'root'
            ]
        }
    }
};

// collection method descriptor
var collectionMethodDescriptorSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        description: {
            type: 'string'
        },
        notes: {
            type: 'string'
        },
        async: {
            type: 'boolean'
        },
        deferredAsync: {
            type: 'boolean'
        },
        advanced: advancedSchema,
        allowedZones: allowedZones,
        handler: {
            type: 'any',
            required: true
        },
        action: {
            type: 'string',
            enum: ['read', 'create', 'update', 'delete', 'head']
        },
        schemas: {
            type: 'object',
            properties: {
                input: objectSchemaOrNull,
                query: objectSchemaOrNull,
                url: objectSchemaOrNull,
                output: objectSchemaOrNull
            },
            additionalProperties: false
        },
        accessLevel: {
            type: 'string',
            enum: [
                'guest',
                'none',
                'viewer',
                'user',
                'admin',
                'root'
            ]
        }
    }
};

/**
 * Create error object that represents error in Conversion error.
 *
 * @param {string} msg   Short description of error.
 * @returns {object}     NEF Error object.
 */
function convertError(msg) {
    return new NefError('EBADARG', msg);
}

/**
 * Parses string value to boolean. The versions with first capital letter are
 * there for python clients where booleans start with capital letter.
 * If it can't be converted, throws error.
 *
 * @param {string} value
 * @returns {boolean}
 */
function boolConvert(value) {
    if (value === 'true' || value === 'True') {
        return true;
    }
    if (value === 'false' || value === 'False') {
        return false;
    }
    throw convertError(__('Wrong boolean value %s', value));
}

/**
 * Convert int string representation to int
 *
 * @param {string} value
 * @returns {number}
 */
function intConvert(value) {
    var intVal = parseInt(value);
    if (isNaN(intVal)) {
        throw convertError(__('Wrong number value %s', value));
    }
    return intVal;
}

/**
 * Convert primitive type represented by string to specified type. In case of
 * error throws convert error.
 *
 * @param {*}      val   Value to be converted.
 * @param {string} type  Type the value should be converted to. Can be either
 *                       string or type object definition from schema.
 * @returns {*}          Value converted to requested primitive type.
 */
convert.fromString = function(val, type) {
    assert.strictEqual(typeof val, 'string');
    if (typeof type === 'object') {
        type = type.type;
    }
    assert.strictEqual(typeof type, 'string');

    switch (type) {
        case 'integer':
        case 'number':
            return intConvert(val);
        case 'boolean':
            return boolConvert(val);
        case 'string':
            return val;
        default:
            throw convertError(__('Not a primitive type: %s', type));
    }
};

/**
 * Take JSON schema of an object and return a deep copy of it containing only
 * top-level properties with primitive types and make all those properties
 * optional.
 *
 * This is handy for constructing query and url schemas from object schema.
 */
convert.primitiveSchema = function(schema) {
    var s = utils.clone(schema);

    for (var p in s.properties) {
        var def = s.properties[p];

        if (['string', 'integer', 'number', 'boolean']
                .indexOf(def.type) !== -1) {
            if (def.required) {
                def.required = false;
            }
        } else {
            delete s.properties[p];
        }
    }
    if (s.required) {
        delete s.required;
    }

    return s;
};

/**
 * Validate request payload and fill default values according to schema.
 * Throws exception if invalid.
 */
convert.validateBody = function(input, schema) {

    if (!schema) {
        if (input) {
            // Restify does not convert JSON body to object if body is not
            // expected for given type of method (i.e. GET).
            if (typeof input !== 'object') {
                throw convertError(__('Unexpected request payload: %s',
                            input.toString()));
            }
            if (Object.keys(input).length > 0) {
                throw convertError(
                        __('Unexpected parameters in request body: %s', input));
            }
        }
        return;
    }

    var err = schemaUtils.validate(input, schema, __('Invalid request'),
            'request');
    if (err) {
        throw err;
    }
};

/**
 * Convert URL parameters as necessary and validate them.
 */
convert.validateUrlParams = function(params, schema) {

    if (!schema) {
        if (Object.keys(params).length > 0) {
            // use EFAILED because if this happens then it's a bug in our code
            throw new NefError('EFAILED', __('Unexpected path parameters: %s',
                    params));
        }
        return;
    }
    for (var p in params) {
        if (params[p] === '') {
            throw convertError(__('Path parameter "%s" is missing', p));
        }
        if (schema.properties[p]) {
            params[p] = convert.fromString(params[p],
                    schema.properties[p].type);
        }
    }
    var err = schemaUtils.validate(params, schema,
            __('Invalid URL parameter'), 'url');
    if (err) {
        throw err;
    }
};

/**
 * Validate request query parameters and convert them as necessary.
 */
convert.validateQueryParams = function(params, schema) {

    if (!schema) {
        if (Object.keys(params).length > 0) {
            throw convertError(__('Unexpected query parameters: %(params)s', {
                params: JSON.stringify(params)
            }));
        }
        return;
    }
    for (var p in params) {
        if (schema.properties[p]) {
            params[p] = convert.fromString(params[p],
                    schema.properties[p].type);
        }
    }
    var err = schemaUtils.validate(params, schema,
            __('Invalid query parameters'), 'query');
    if (err) {
        throw err;
    }
};

/**
 * Validate reply payload according to schema (take into account that
 * fields could have been filtered).
 * Throws exception if invalid. Exception code is 'EFAILED' because
 * generating invalid response is server internal error.
 *
 * @param {object} output  Data to be validated.
 * @param {object} schema  JSON schema.
 * @param {array}  fields  Top-level properties of object to validate.
 */
convert.validateReply = function(output, schema, fields) {

    if (!schema) {
        if (output && Object.keys(output).length > 0) {
            throw new NefError('EFAILED',
                    __('Method generated unexpected output: %s', output));
        }
        return;
    }
    if (fields) {
        schema = utils.clone(schema);
        var objDef = (schema.type === 'array') ? schema.items : schema;

        objDef.properties = utils.copyFields(objDef.properties, fields);
        // if required is defined at object level filter the required list
        if (utils.isArray(objDef.required)) {
            objDef.required = objDef.required.filter(function(ent) {
                return (fields.indexOf(ent) !== -1);
            });
        }
    }

    var err = schemaUtils.validate(output, schema, __('Invalid reply'),
            'reply');
    if (err) {
        // a bit of hack but default code EBADARG is not appropriate
        // in this case
        err.code = 'EFAILED';
        throw err;
    }
};

/**
 * Validate backend module descriptor and throw error if invalid.
 */
convert.validateModuleDescriptor = function(desc) {
    var err = schemaUtils.validate(desc, moduleDescriptorSchema,
            __('Invalid backend descriptor "%s"', desc.name || 'unknown'),
            'descriptor');
    if (err) {
        throw err;
    }
    if (desc.initialize && typeof desc.initialize !== 'function') {
        throw new Error(desc.name + ' initializer must be a function');
    }
};

/**
 * Validate handler descriptor and throw error if invalid.
 */
convert.validateHandlerDescriptor = function(desc) {
    var err = schemaUtils.validate(desc, handlerDescriptorSchema,
            __('Invalid "%s" handler descriptor', desc.id || 'unknown'),
            'descriptor');
    if (err) {
        throw err;
    }
    if (typeof desc.handler !== 'function') {
        throw new Error('Handler in ' + desc.id + ' must be a function');
    }
};

/**
 * Validate collection descriptor and throw error if invalid.
 */
convert.validateCollectionDescriptor = function(desc) {
    var err = schemaUtils.validate(desc, collectionDescriptorSchema,
            __('Invalid collection descriptor "%s"', desc.id || 'unknown'),
            'descriptor');
    if (err) {
        throw err;
    }
    if (!desc.handler && !desc.methods.read) {
        throw new Error('Missing read method in ' + desc.id);
    }
};

/**
 * Validate collection method descriptor and throw error if invalid.
 */
convert.validateCollectionMethodDescriptor = function(cid, action, desc) {
    var err = schemaUtils.validate(desc, collectionMethodDescriptorSchema,
            __('Invalid "%s" collection method descriptor "%s"',
                cid, action || 'unknown'), 'descriptor');
    if (err) {
        throw err;
    }
    if (typeof desc.handler !== 'function') {
        throw new Error('Handler in ' + cid + ' ' + action +
                ' must be a function');
    }
};

module.exports = convert;
