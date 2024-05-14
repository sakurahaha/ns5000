/**
 * @FileOverview Swagger resource class
 * Copyright (C) 2014 Nexenta Systems, Inc
 * All rights reserved.
 **/

var restUtils = require('nef/restUtils');
var utils = require('nef/utils');
var log = require('nef/logger');
var spec = require('./spec.js');
var assert = require('assert');

/**
 * Swagger resource representation. Resource contains one or more paths
 * for collections and/or single objects and a set of operations on them
 *
 * @param {object} resource  restify API object
 * @constructor
 */
var Resource = function(resource, version) {
    var self = this;

    self.version = version;
    self.models = {};
    self.paths = {};
    self.responses = {};
    self.resource = resource;
    self.collections = {};

    self.createCollections();
    self.createPaths();
    self.createModels();
};

/**
 * Merge with another resource
 */
Resource.prototype.mergeResource = function(another) {
    var self = this;

    for (var x in another.models) {
        self.models[x] = another.models[x];
    }
    for (var y in another.paths) {
        self.paths[y] = another.paths[y];
    }
    for (var z in another.responses) {
        self.responses[z] = another.responses[z];
    }
    for (var c in another.collections) {
        self.collections[c] = another.collections[c];
    }
};

/**
 * Mark collection methods for more readable model names
 */
Resource.prototype.createCollections = function() {
    var self = this;
    var res = self.resource;
    var collections = self.resource.collections || undefined;

    if (res && collections && typeof collections == 'object') {

        for (var i in collections) {
            if (!(self.version in collections[i].versions)) {
                // not the right version
                continue;
            }
            collection = collections[i].versions[self.version];

            self.collections[i] = collection;
            for (var m in collection.methods) {
                self.collections[m + '_' + i] = collection;
            }
        }

    } else {
        log.error(__('swagger resource: wrong resource %',
            this.resource.toString()));
        return;
    }
};

/**
 * Convert resource paths to swagger form and build path map
 */
Resource.prototype.createPaths = function() {
    var self = this;
    var modNames = {};

    if (!self.resource || !self.resource.name) {
        log.error(__('Resource has no _name property.'));
        return;
    }

    for (var method in self.resource.methods) {
        var current = self.resource.methods[method];

        if (current.hidden) {
            continue;
        }

        if (!(self.version in current.versions)) {
            // not the right version
            continue;
        }
        current = current.versions[self.version];

        var url = current.url;

        if (!url) {
            continue;
        }
        url = reformatPath(url);
        if (current.urlProxy) {
            url += '/{proxyPath}';
        }

        while (url[0] == '/') {
            url = url.slice(1);
        }

        if (!self.paths[url]) {
            self.paths[url] = [current];
        } else {
            self.paths[url].push(current);
        }
    }
};

/**
 * Create response models for all resource methods
 */
Resource.prototype.createModels = function() {
    var self = this;

    // take collection name and make singular form
    var guessByUrl = function(url) {
        try {
            var x = url.split('/')[1];
            if (x[x.length - 1] == 's' &&
                ['a', 'o', 'e', 'i', 'y', 'u'].indexOf(x[x.length - 2]) < 1) {
                return x.slice(0, x.length - 1).toLowerCase();
            } else {
                return x.toLowerCase();
            }
        } catch (e) {}
    };

    var createModel = function(handler) {
        var keyName;
        self.currentMethod = handler.id;
        if (handler.schemas && handler.schemas.output) {
            // find good name for model
            if (self.collections[handler.id]) {
                keyName = toCamelCase(self.collections[handler.id].objectName);
                if (self.models[keyName]) {
                    keyName = toCamelCase(handler.id);
                }
            } else {
                keyName = toCamelCase(handler.id);
            }

            self.responses[handler.id] = self.addObjectModel(
                keyName, handler.schemas.output);
        }
    };

    for (var path in self.paths) {
        self.paths[path].forEach(createModel, self);
    }
};

/**
 * Add new swagger data model (and all submodels)
 *
 * @param {String} name      name of the new model
 * @param {object} object    jsonschema v4 object
 * @returns {*}
 */
Resource.prototype.addObjectModel = function(name, object, action) {
    var self = this;
    var requiredProps = (typeof object.required == typeof []) ?
            object.required : [];

    try {
        var submodel = {
            id: name,
            additionalProperties: true,
            properties: {},
        };

        // fallback to safe value
        if (!object) {
            return 'string';
        }

        if (object.type == 'object') {
            if (object.hasOwnProperty('patternProperties')) {
                submodel.patternProperties = object.patternProperties;
            }
            if (object.additionalProperties === false) {
                submodel.additionalProperties = false;
            }

            if (!object.properties ||
                Object.keys(object.properties).length == 0) {

                if (!object.patternProperties) {
                    return 'object';
                }
            }
            object = object.properties || {};
        } else if (object.type == 'array') {
            if (object.items.hasOwnProperty('patternProperties')) {
                submodel.patternProperties = object.patternProperties;
            }
            if (object.items.additionalProperties === false) {
                submodel.additionalProperties = false;
            }
            if (object.items.hasOwnProperty('oneOf')) {
                object = buildProperties(object.items.oneOf);
                object = object.properties;
            } else {
                requiredProps = object.items.required || [];
                object = object.items.properties;
            }
        }

        var onlyRequired = function(n) {
            return object[n].required || requiredProps.indexOf(n) > -1;
        };

        var onlyOptional = function(n) {
            return !object[n].required && requiredProps.indexOf(n) < 0;
        };

        var reqProps = Object.keys(object).filter(onlyRequired).sort();
        var optProps = Object.keys(object).filter(onlyOptional).sort();

        var enumeration = reqProps.concat(optProps);

        for (var e in enumeration) {
            var p = enumeration[e];

            // skip special properties
            if (['href', 'links'].indexOf(p) > -1) {
                continue;
            }

            var required;
            if (typeof object[p].required == 'boolean') {
                required = object[p].required;
            } else {
                required = requiredProps.indexOf(p) > -1;
            }

            // show multiple possible types as string
            if (typeof object[p].type == typeof []) {
                var visType = object[p].type.join(' or ');
                submodel.properties[p] = spec.parameterObject(p, visType,
                    object[p].description, object[p].example,
                    undefined, object[p].enum, required, object[p].shortName,
                    object[p].formatter, object[p].unencoded);
                continue;
            }

            if (['array', 'object'].indexOf(object[p].type) < 0) {
                submodel.properties[p] = utils.clone(object[p]);
                submodel.properties[p].required = required;
            } else if (object[p].type == 'object') {
                submodel.properties[p] = spec.parameterObject(name + '_' + p,
                    self.addObjectModel(name + '_' + p, object[p]), // parameter type
                    object[p].description, object[p].example,
                    undefined, object[p].enum, required, object[p].shortName,
                    object[p].formatter, object[p].unencoded);
            } else {
                var objectItems = object[p].items;

                if (!objectItems) {
                    log.warn(__('swagger: use \'items\' instead of \'item\'' +
                        ' for %s in %s.', p, self.currentMethod));
                } else {
                    if (object[p].items.hasOwnProperty('oneOf')) {
                        objectItems = buildProperties(object[p].items.oneOf);
                        log.debug(__('swagger: concatenating multiple item ' +
                            'variants for %s in %s.', p, self.currentMethod));
                    }

                    if (objectItems.type != 'object') {
                        submodel.properties[p] = {
                            description: object[p].description,
                            type: 'array',
                            required: required,
                            items: objectItems
                        };
                    } else {
                        submodel.properties[p] = {
                            description: object[p].description,
                            type: 'array',
                            required: required,
                            items: {
                                '$ref': self.addObjectModel(name + '_' + p,
                                        objectItems)
                            }
                        };
                    }

                    ['shortName', 'formatter'].forEach(function(i) {
                        if (i in object[p]) {
                            submodel.properties[p][i] = object[p][i];
                        }
                    });
                }
            }
        }

        // object is unspecified
        if (Object.keys(submodel.properties).length < 1 &&
            !submodel.hasOwnProperty('patternProperties')) {
            return 'object';
        }

        // check if the same model exists
        while (self.models[submodel.id]) {
            if (JSON.stringify(self.models[submodel.id].properties) ==
                JSON.stringify(submodel.properties)) {
                return submodel.id;
            } else if (action && submodel.id.indexOf(action) < 0) {
                submodel.id += action;
            } else {
                submodel.id += '_';
            }
        }

        self.models[submodel.id] = submodel;
        return submodel.id;
    } catch (e) {
        return 'string';
    }
};

/**
 * Return swagger API schema
 *
 * @returns {*}
 */
Resource.prototype.schema = function() {
    var self = this;

    if (!self.cachedSpec) {
        var createPath = self.createPath.bind(self);
        var apis = Object.keys(self.paths).map(createPath);

        self.cachedSpec = spec.apiDeclaration(self.models, apis, self.version);
    }

    return self.cachedSpec;
};

/**
 * Create API description for some path
 *
 * @param {String} path
 * @returns {*}
 */
Resource.prototype.createPath = function(path) {
    var self = this;
    var createMethod = self.createMethod.bind(self);

    return spec.apiObject(path, self.paths[path].map(createMethod));
};

/**
 * Create method description
 *
 * @param {object} method   REST method descriptor
 * @returns {*}
 */
Resource.prototype.createMethod = function(method) {
    var self = this;
    var params = self.createParams.bind(self);
    var responses = self.createResponses.bind(self);

    self.currentMethod = method.id;

    return spec.operationObject(
        method.description,
        method.id,
        restUtils.mapHTTPMethod(method.action).usr,
        params(method),
        responses(method),
        self.responses[method.id],
        method.notes,
        method.async
    );
};

/**
 * Create parameters description for some method
 *
 * @param {object} method   REST method descriptor
 * @returns {Array}
 */
Resource.prototype.createParams = function(method) {
    var self = this;

    var endsWith = function(str, suffix) {
        return str.indexOf(suffix, str.length - suffix.length) !== -1;
    };

    if (method.handler.swagger) {
        return method.handler.swagger;
    }

    if (!method.schemas) {
        log.debug('swagger: no schemas for method %s.', method.id);
        return [];
    }

    if (!method.url || typeof method.url !== 'string') {
        log.debug('swagger: method without url %s.', method.id);
        return [];
    }

    var params = [];
    var prop;
    var inputModel;

    // create list of params that are in methods url
    var urlpaths = method.url.split('/').filter(function(x) {
        return (x[0] === ':' && x.length > 1);
    }).map(function(x) {
        return x.slice(1);
    });

    var primitives = ['string', 'boolean', 'integer', 'number'];

    if (method.schemas.url) {
        assert(method.schemas.url.hasOwnProperty('properties'),
            __('swagger: URL schema for %s has incorrect format.', method.id));

        for (var n in urlpaths) {
            prop = method.schemas.url.properties[urlpaths[n]];

            if (primitives.indexOf(prop.type) > -1) {
                params.push(spec.parameterObject(urlpaths[n],
                    prop.type, prop.description,
                    prop.example, 'path', prop.enum,
                    prop.required, prop.shortName, prop.formatter,
                    prop.unencoded));
                delete urlpaths[n];
            }

        }
    }

    urlpaths.forEach(function(x) {
        log.warn(__('swagger: define url schema for %s in %s', x, method.id));
        params.push(spec.parameterObject(x, 'string', '', undefined, 'path'));
    });

    if (method.urlProxy) {
        params.push(spec.parameterObject('proxyPath', 'string',
                'URL path', 'i.e. inventory/cpus', 'path', undefined, true));
    }

    if (method.schemas.query) {
        if (method.schemas.query.properties) {
            for (var j in method.schemas.query.properties) {
                prop = method.schemas.query.properties[j];

                if (primitives.indexOf(prop.type) > -1) {
                    if (method.schemas.url &&
                        method.schemas.url.properties.hasOwnProperty(j)) {
                        prop.description += ' (query parameter)';
                    }
                    params.push(spec.parameterObject(j, prop.type,
                        prop.description, prop.example, 'query', prop.enum,
                        undefined, prop.shortName, prop.formatter,
                        prop.unencoded));
                } else {
                    log.warn(__('swagger: skip %s (type: %s) in query of %s ' +
                            ' action parameters of %s.', j, prop.type,
                            method.action, method.id));
                }
            }
        }
    }

    // double check body for (delayed) POST/PUT
    if (method.action === 'create' ||
        method.action === 'update') {
        var goodName = self.collections[method.id] ?
                self.collections[method.id].objectName : method.id;
        var methodAction = method.action == 'create' ? 'Input' : 'Update';

        if (self.models[toCamelCase(goodName) + methodAction]) {
            goodName = method.id;
        }

        goodName = toCamelCase(goodName);

        if (method.schemas.input) {
            var methodInput = method.schemas.input;
            if (method.schemas.input.hasOwnProperty('oneOf')) {
                methodInput = buildProperties(method.schemas.input.oneOf);
                log.debug(__('swagger: multiple options for %s input, ' +
                    'concatenating them.', method.id));
            }

            if (methodInput.properties || methodInput.items ||
                methodInput.patternProperties) {
                inputModel = self.addObjectModel(goodName,
                    methodInput, methodAction);

                if (inputModel != 'string') {
                    params.push(spec.parameterObject('body', inputModel,
                        method.schemas.input.description,
                        method.schemas.input.example, 'body', undefined,
                        undefined, method.schemas.input.shortName,
                        method.schemas.input.formatter,
                        method.schemas.input.unencoded));
                }
            }
        }
    } else {
        if (method.schemas.input) {
            log.warn(__('swagger: skip input method for %s action of %s',
                method.action, method.id));
        }
    }

    return params;
};

/**
 * Generate response codes
 *
 * @param {object} method   REST method descriptor
 */
Resource.prototype.createResponses = function(method) {
    var self = this;
    var standardResponses = {
        200: 'OK',
        201: 'Created',
        202: 'In progress',
        400: 'Invalid parameters',
        404: 'Not found',
        500: 'Internal server error'
    };
    var resp = [400, 500];

    if (method.async) {
        resp.push(202);
    }
    if (method.action === 'create') {
        resp.push(201);
    } else {
        resp.push(200);
    }
    // if there is at least one parameter in URL then "not found" is possible
    if (method.url.indexOf('/:') !== -1) {
        resp.push(404);
    }

    resp.sort();

    return resp.map(function(x) {
        return {
            code: x,
            message: standardResponses[x]
            //responseModel: (x >= 400) ? 'ErrorModel' : undefined
        };
    });
};

/**
 * Convert path from restify format to swagger form
 *
 * @param {String} path     resource path in restify format
 * @returns {*}
 */
function reformatPath(path) {

    if (path.indexOf(':') < 0) {
        return path;
    }

    return (path.split('/')
        .map(function(part) {
            if (part && part[0] == ':') {
                return '{' + part.slice(1) + '}';
            } else {
                return part;
            }
        })
        .join('/'));
}

/**
 * Convert object name, id or description to camelCaseName
 *
 * @type {Resource}
 */
function toCamelCase(name) {
    name = name.replace(/_/g, ' ');
    name = name.split(' ').filter(function(x) {
        return (x !== '' && x !== ' ');
    });

    if (name.length > 0) {
        for (var i in name) {
            if (name[i].length < 2) {
                continue;
            } else if (i == 0) {
                name[i] = name[i].toLowerCase();
            } else {
                name[i] = name[i][0].toUpperCase() + name[i].slice(1);
            }
        }
    }

    return name.join('');
}

/**
 * Merge multiple objects (from oneOf) to build single object
 */
function buildProperties(objArr) {
    var obj = {};

    for (var o in objArr) {
        for (var p in objArr[o].properties) {
            if (!obj[p]) {
                obj[p] = objArr[o].properties[p];
            }
        }
    }
    return {
        type: 'object',
        properties: obj
    };
}

module.exports = Resource;
