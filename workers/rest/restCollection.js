/**
 * @fileOverview Implementation of collection descriptors. It can be used
 * by backend writers to describe a collection with less typing than if
 * low-level method definitions were used and also it guarantees that
 * collection ops comply to REST API consistency rules.
 */

var assert = require('assert');
var async = require('async');
var nef = require('nef');
var logger = require('nef/logger');
var utils = require('nef/utils');
var schemaUtils = require('nef/schemaUtils');
var restUtils = require('nef/restUtils');
var restConvert = require('./restConvert');

var restConfig = utils.requireConfig('config/rest');

var coll = {}; // exported stuff from this module

/**
 * Build a paginated URL string using restify request object and
 * custom 'offset' and 'limit'.
 *
 * returns URL in the following form: /<url>?offset=X&limit=Y
 */
function buildPaginatedUrl(req, offset, limit) {
    var url = req.getPath();
    var first = true;
    var offsetSeen = false;
    var limitSeen = false;

    function addParam(param, val) {
        if (first) {
            url += '?';
            first = false;
        } else {
            url += '&';
        }
        url += encodeURIComponent(param) + '=' + encodeURIComponent(val);
    }

    for (var i in req.query) {
        if (i === 'offset') {
            addParam('offset', offset);
            offsetSeen = true;
        } else if (i === 'limit') {
            addParam('limit', limit);
            limitSeen = true;
        } else if (i === 'fields') {
            // fields is different because it was preprocessed by server
            if (req.query.fields) {
                url += (first) ? '?' : '&';
                first = false;
                url += 'fields=' + req.query.fields.map(function(f) {
                    return encodeURIComponent(f);
                }).join(',');
            }
        } else {
            addParam(i, req.query[i]);
        }
    }

    if (!offsetSeen) {
        addParam('offset', offset);
    }
    if (!limitSeen) {
        addParam('limit', limit);
    }

    return url;
}

/**
 * Wrap user provided collection read handler by standard collection code for
 * pagination support and metadata.
 */
function decorateCollectionRead(handler, key) {

    var wrapper = function CollectionReadDecorator(req, done) {
        // normalize pagination fields
        if (!req.query.offset || req.query.offset < 0) {
            req.query.offset = 0;
        }
        if (!req.query.limit || req.query.limit < 1) {
            req.query.limit = restConfig.collectionDefaultPageLimit;
        }
        if (req.query.limit > restConfig.collectionMaxPageLimit) {
            req.query.limit = restConfig.collectionMaxPageLimit;
        }

        /*
         * XXX: To determine the presence of the next page, we use
         * the following approach: we transparently request one extra element
         * from the backend, and if we receive it, we assume that the next page
         * is available. Of course such an element isn't returned to the client
         * and is silently discarded.
         * Total overhead is one extra element, which is a good tradeoff for
         * now. Later we can implement more sophisticated approach based on
         * collection meta information.
         */
        req.query.limit += 1;

        // Collection key cannot be filtered out, we need it for href link
        if (req.query.fields && req.query.fields.indexOf(key) === -1) {
            req.query.fields.push(key);
        }

        handler(req, function(err, res) {
            var prevOffset;
            var prevLimit;

            if (err) {
                done(err);
                return;
            }

            if (res.length > req.query.limit) {
                logger.warn(__('%(url)s returned %(real)d entries but only ' +
                    '%(should)d were requested', {
                        url: req.url,
                        real: res.length,
                        should: req.query.limit
                    }));
            }

            // Handle the next page, if any and remove extra element
            if (res.length === req.query.limit) {
                res.pop();
                req.metadata.links.push({
                    rel: 'next',
                    href: buildPaginatedUrl(req,
                            req.query.offset + req.query.limit - 1,
                            req.query.limit - 1)
                });
            }
            req.query.limit -= 1;

            // Handle the previous page, if any
            if (req.query.offset > 0) {
                if (req.query.offset >= req.query.limit) {
                    prevOffset = req.query.offset - req.query.limit;
                    prevLimit = req.query.limit;
                } else {
                    prevOffset = 0;
                    prevLimit = req.query.offset;
                }
                req.metadata.links.push({
                    rel: 'prev',
                    href: buildPaginatedUrl(req, prevOffset, prevLimit)
                });
            }

            // syntetize href attribute for each returned entry
            if (req.query.fields && req.query.fields.indexOf('href') === -1) {
                req.query.fields.push('href'); // href cannot be filtered out
            }
            res = res.map(function(e) {
                // be safe and don't modify object passed from handler
                if (!e.href) {
                    e = utils.objectCopy(e);
                    e.href = req.getPath() + '/' + encodeURIComponent(e[key]);
                }
                return e;
            });

            req.responseHeaders['X-Items-Count'] = res.length;

            done(null, res);
        });
    };

    return wrapper;
}

/**
 * Wrap user provided read handler by a code inserting metadata into
 * the request.
 */
function decorateDetailRead(handler) {
    var wrapper = function detailReadDecorator(req, done) {
        handler(req, function(err, res) {
            req.metadata.links.push({
                rel: 'collection',
                href: req.url.slice(0, req.getPath().lastIndexOf('/'))
            });
            done(err, res);
        });
    };

    return wrapper;
}

/**
 * Wrap user provided create handler to indirectly insert "Location" header
 * into the response.
 */
function decorateCreate(handler, cdesc) {
    var wrapper = function createDecorator(req, done, progress, asyncDone) {
        handler(req, function(err, res) {
            if (err) {
                done(err);
                return;
            }
            var id = req.body[cdesc.key];
            if (id === undefined) {
                id = 'undefined';
                logger.warn(__('Missing ID of newly created %s in %s ' +
                        'collection', cdesc.objectName, cdesc.id));
            }
            req.responseHeaders['Location'] = req.getPath() + '/' +
                    encodeURIComponent(id);
            req.responseStatus = 201; // Object created
            done(err, res);
        }, progress, asyncDone);
    };

    return wrapper;
}

/**
 * Return a shallow copy of schema containing only properties for parameters
 * in URL.
 */
function filterUrlParams(url, schema) {
    var params = restUtils.getUrlParameters(url);
    var schema = utils.clone(schema);

    for (var p in schema.properties) {
        if (params.indexOf(p) === -1) {
            delete schema.properties[p];
        }
    }
    return schema;
}

/**
 * Expand high-level collection description to low-level method descriptors
 * which can be registered with restify server.
 *
 * @param {Object}  cdesc    Collection descriptor.
 * @param {Boolean} validate True if collection descriptor should be validated according
 *                  to JSON schema.
 * @returns {Object[]} Array of method descriptors.
 */
coll.genCollectionMethods = function(cdesc, validate) {
    var mdescs = [];
    var collectionReadMdesc;
    var collectionHeadMdesc;
    var entryReadMdesc;
    var mdesc;

    if (validate) {
        restConvert.validateCollectionDescriptor(cdesc);
        if (cdesc.objectSchema) {
            var err = schemaUtils.validateSchema(cdesc.objectSchema, cdesc.id);
            if (err) {
                throw err;
            }
        }
    }

    var primitiveSchema = restConvert.primitiveSchema(cdesc.objectSchema);
    var parent = {};
    if (cdesc.attachTo) {
        parent.id = cdesc.attachTo.id;
        parent.paramsMap = cdesc.attachTo.paramsMap;
    }

    // expand missing properties in method descriptors
    for (var m in cdesc.methods) {
        var method = cdesc.methods[m];
        if (typeof method === 'function') {
            cdesc.methods[m] = method = {
                handler: method
            };
        } else if (validate) {
            restConvert.validateCollectionMethodDescriptor(cdesc.id, m,
                    method);
        }

        if (!method.description) {
            method.description = m + ' ' + cdesc.objectName;
        }
        if (!method.schemas) {
            method.schemas = {
                input: null,
                output: null,
                url: null,
                query: null
            };
        } else {
            for (var s in method.schemas) {
                if (method.schemas[s]) {
                    var err = schemaUtils.validateSchema(method.schemas[s],
                            cdesc.id + '.' + s);
                    if (err) {
                        throw err;
                    }
                }
            }
        }

        if (!method.allowedZones) {
            method.allowedZones = cdesc.allowedZones || ['global'];
        }
    }

    /*
     * Generate method for reading collection
     */
    collectionReadMdesc = {
        id: cdesc.id,
        version: cdesc.version,
        isCollection: true,
        collectionId: cdesc.id,
        action: 'read',
        url: cdesc.url,
        description: cdesc.description ||
                ('Collection of ' + cdesc.objectName + ' objects'),
        notes: cdesc.notes,
        allowedZones: cdesc.allowedZones,
        schemas: {
            input: null,
            output: {
                type: 'array',
                // allow href meta-data for element listing
                items: schemaUtils.addObjectProperty(cdesc.objectSchema,
                        'href', {
                    type: 'string'
                })
            },
            url: filterUrlParams(cdesc.url, primitiveSchema),
            query: utils.extend({}, {
                additionalProperties: false,
                properties: restUtils.paginationFieldKeys
            }, primitiveSchema, cdesc.querySchema || {})
        },
        handler: decorateCollectionRead(cdesc.handler ||
                cdesc.methods.read.handler, cdesc.key),
        accessLevel: cdesc.accessLevel,
        parent: parent,
        children: [],
        skipParentCheck: !!cdesc.skipParentCheck,
        advanced: cdesc.advanced || {}
    };
    mdescs.push(collectionReadMdesc);

    /*
     * Generate method for reading metadata using HEAD for entire collection
     */
    collectionHeadMdesc = utils.extend({}, collectionReadMdesc, {
        hidden: true,
        id: 'collhead_' + cdesc.id,
        action: 'head',
        description: 'Autogenerated HEAD hendler for collection of ' +
                     cdesc.objectName
    });
    mdescs.push(collectionHeadMdesc);

    /*
     * Generate method for reading entry (it has to go first because it is
     * referenced by other methods).
     */
    var entryUrl = ':' + cdesc.key;  // relative entry URL
    if (cdesc.methods.read) {
        var method = cdesc.methods.read;

        assert(!method.async, 'read method in ' + cdesc.id +
                ' cannot be async');
        assert(!method.schemas.input, 'read method in ' + cdesc.id +
                ' cannot have input schema');

        entryReadMdesc = {
            id: 'read_' + cdesc.id, // unique method ID
            isCollectionEntry: true,
            collectionId: cdesc.id,
            action: 'read',
            url: entryUrl,
            description: method.description,
            notes: method.notes,
            allowedZones: method.allowedZones,
            schemas: {
                input: null,
                url: method.schemas.url ||
                        filterUrlParams(entryUrl, primitiveSchema),
                // by default object detail = element in collection
                output: method.schemas.output || cdesc.objectSchema,
                // fields selector is always supported
                query: utils.extend({}, {
                    type: 'object',
                    properties: restUtils.fieldKeys,
                    additionalProperties: false
                }, method.schemas.query || {})
            },
            handler: decorateDetailRead(cdesc.methods.read.handler),
            accessLevel: method.accessLevel,
            parent: {
                id: cdesc.id,
                rel: 'action/read'
            },
            children: [],
            skipParentCheck: !!cdesc.skipParentCheck,
            advanced: cdesc.advanced || {}
        };
        mdescs.push(entryReadMdesc);
    }

    /*
     * Generate method for reading entry meta data.
     */
    if (cdesc.methods.head) {
        var method = cdesc.methods.head;

        assert(!method.async, 'head method in ' + cdesc.id +
                ' cannot be async');
        assert(!method.schemas.input, 'head method in ' + cdesc.id +
                ' cannot have input schema');

        mdesc = {
            id: 'head_' + cdesc.id, // unique method ID
            collectionId: cdesc.id,
            action: 'head',
            url: entryUrl,
            description: method.description,
            notes: method.notes,
            allowedZones: method.allowedZones,
            schemas: {
                input: null,
                url: method.schemas.url ||
                        filterUrlParams(entryUrl, primitiveSchema),
                output: null,
                // fields selector is always supported
                query: utils.extend({}, {
                    type: 'object',
                    properties: restUtils.fieldKeys,
                    additionalProperties: false
                }, method.schemas.query || {})
            },
            handler: decorateDetailRead(cdesc.methods.head.handler),
            accessLevel: method.accessLevel,
            parent: {
                id: cdesc.id,
                rel: 'action/head'
            },
            children: [],
            advanced: method.advanced || {}
        };
        mdescs.push(mdesc);
    }

    /*
     * Generate method for creating entry.
     */
    if (cdesc.methods.create) {
        var method = cdesc.methods.create;

        // assert(!method.schemas.output, 'create method in ' + cdesc.id +
        //         ' cannot have output schema');

        mdesc = {
            id: 'create_' + cdesc.id, // unique method ID
            collectionId: cdesc.id,
            action: 'create',
            url: '',  // relative URL to parent
            description: method.description,
            notes: method.notes,
            allowedZones: method.allowedZones,
            schemas: {
                // by default object schema is used for validation of input
                input: method.schemas.input || cdesc.objectSchema,
                output: method.schemas.output || null,
                url: method.schemas.url,
                query: method.schemas.query
            },
            // creates href attribute which is used for Location header
            handler: decorateCreate(method.handler, cdesc),
            accessLevel: method.accessLevel,
            async: cdesc.asyncMethods || method.async || false,
            deferredAsync: method.deferredAsync || false,
            parent: {
                id: cdesc.id,
                rel: 'action/create'
            },
            children: [],
            advanced: method.advanced || {}
        };
        mdescs.push(mdesc);
    }

    /*
     * Generate all other method descriptors acting on a collection entry.
     */
    for (var m in cdesc.methods) {
        var method = cdesc.methods[m];
        var action = m;
        var url = '';

        if (m === 'read' || m === 'create' || m === 'head') {
            continue; // already generated
        }

        // non-standard action
        if (!restUtils.mapHTTPMethod(m)) {
            url += m;
            // by default all non-standard actions are POST
            action = method.action || 'create';
        } else {
            // standard action
            if (m === 'update') {
                if (!method.schemas.input) {
                    var schema;

                    if (cdesc.methods.create &&
                            cdesc.methods.create.schemas.input) {
                        schema = cdesc.methods.create.schemas.input;
                    } else {
                        schema = cdesc.objectSchema;
                    }

                    // ID is not required for update op (it is in URL)
                    if (schema.properties[cdesc.key]) {
                        schema = utils.clone(schema);
                        delete schema.properties[cdesc.key];
                    }
                    method.schemas.input = schema;
                }
            } else {
                assert.strictEqual(m, 'delete');
                assert(!method.schemas || !method.schemas.input,
                        'delete method in ' + cdesc.id + ' cannot have ' +
                        'input schema');
                assert(!method.schemas || !method.schemas.output,
                        'delete method in ' + cdesc.id + ' cannot have ' +
                        'output schema');
            }
        }

        mdesc = {
            id: m + '_' + cdesc.id, // unique method ID
            collectionId: cdesc.id,
            action: action,
            url: url,
            description: method.description,
            notes: method.notes,
            allowedZones: method.allowedZones,
            schemas: {
                input: method.schemas.input,
                output: method.schemas.output,
                url: method.schemas.url,
                query: method.schemas.query
            },
            handler: method.handler,
            accessLevel: method.accessLevel,
            async: (action !== 'read') &&
                    cdesc.asyncMethods || method.async || false,
            deferredAsync: method.deferredAsync || false,
            parent: {
                id: entryReadMdesc.id,
                rel: 'action/' + m
            },
            children: [],
            advanced: method.advanced || {}
        };
        mdescs.push(mdesc);
    }

    return mdescs;
};

module.exports = coll;
