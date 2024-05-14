/*
 * REST API backend for purpose of testing REST.
 *
 * Copyright (C) 2014 Nexenta Systems, Inc
 * All rights reserved.
 */

var async  = require('async');
var assert = require('assert');
var NefError = require('nef/error').NefError;
var utils  = require('nef/utils');
var interop = require('nef/interop');
var restUtils = require('nef/restUtils');
var commonConfig = utils.requireConfig('config/common');

// database of humans for test people collection
var people = {};

var humanSchema = {
    type: 'object',
    properties: {
        idCardNumber: {
            description: 'ID card number',
            type: 'integer',
            required: true
        },
        name: {
            description: 'Name(s)',
            type: 'string',
            required: true
        },
        age: {
            description: 'Age',
            type: 'integer',
            required: false
        },
        married: {
            description: 'Marital status',
            type: 'boolean',
            required: true
        }
    },
    additionalProperties: false
};

var humanCreateSchema = utils.clone(humanSchema);
humanCreateSchema.properties.married.required = false;
humanCreateSchema.properties.married.default = false;

var humanUpdateSchema = {
    type: 'object',
    properties: utils.copyFields(humanCreateSchema.properties,
            ['age', 'married']),
    additionalProperties: false
};

var babySchema = {
    type: 'object',
    properties: {
        id: {
            description: 'Opaque ID of the baby',
            type: 'integer',
            required: true
        },
        name: {
            description: 'First name of the baby',
            type: 'string',
            required: true
        },
        born: {
            description: 'Date and time when the baby was born',
            type: 'string',
            format: 'date-time'
        }
    },
    additionalProperties: false
};
var babyCreateSchema = utils.clone(babySchema);
delete babyCreateSchema.properties.id;

var toySchema = {
    type: 'object',
    properties: {
        name: {
            description: 'Name of the toy',
            type: 'string',
            required: true
        }
    }
};

var ageSchema = {
    type: 'object',
    properties: {}
};

var asyncOpQuerySchema = {
    type: 'object',
    properties: {
        delay: {type: 'integer'}
    }
};

var babyIdCounter = 1; // ID generator for babies

function stripBabies(human) {
    if (!human) {
        return human;
    }
    var res = utils.clone(human);
    delete res.babies;
    return res;
}

function asyncOpBody(delay, progressCb, done) {
    var i = 0;

    delay = delay || 5;

    // n seconds, every second a progress call
    async.whilst(
        function() { return i < delay; },
        function(next) {
            progressCb(i++);
            setTimeout(next, 1000);
        },
        function(err) {
            done(err);
        });
}

/*
 * API is defined so that we can test:
 *
 * collection handlers:
 *   1) GET on collection
 *   2) GET, POST, PUT, DELETE on collection element
 *   3) non-standard action on collection element
 *   4) nested collection with async ops
 *
 * input validation (on PUT method)
 *
 * async ops for POST, PUT, DELETE methods
 */
module.exports = {
    name: 'Test API',
    collections: [{
        id: 'people',
        url: '/test/people',
        key: 'idCardNumber',
        description: 'Collection of people used for testing REST server',
        objectName: 'human',
        objectSchema: humanSchema,
        allowedZones: ['global', 'test'],
        handler: function readPeople(req, done) {
            var res;

            assert(req.params.idCardNumber === undefined);
            res = Object.keys(people).map(function(k) {
                return stripBabies(people[k]);
            });
            res = restUtils.filterResult(res, req.query,
                    ['limit', 'offset', 'fields']);
            res = restUtils.fitPage(req, res);
            utils.callAsync(done, null, res);
        },
        methods: {
            'read': {
                handler: function readHuman(req, done) {
                    var res;

                    if (req.params.idCardNumber) {
                        res = stripBabies(people[req.params.idCardNumber]);
                    } else {
                        res = Object.keys(people).map(function(k) {
                            return stripBabies(people[k]);
                        });
                        res = restUtils.filterResult(res, req.query,
                                ['limit', 'offset', 'fields']);
                        res = restUtils.fitPage(req, res);
                    }
                    if (!res) {
                        utils.callAsync(done,
                                NefError('ENOENT', 'no such human'));
                    } else {
                        utils.callAsync(done, null, res);
                    }
                }
            },
            'head': {
                handler: function headHuman(req, done) {
                    utils.callAsync(done, null);
                }
            },
            'update': {
                handler: function writeHuman(req, done) {
                    var res;
                    var oldHuman = people[req.params.idCardNumber];

                    if (!oldHuman) {
                        return utils.callAsync(done,
                                NefError('ENOENT', 'no such human'));
                    }

                    people[oldHuman.idCardNumber] = utils.extend(req.body, {
                        idCardNumber: oldHuman.idCardNumber,
                        name: oldHuman.name
                    });
                    utils.callAsync(done);
                },
                schemas: {
                    input: humanUpdateSchema
                }
            },
            'create': {
                handler: function createHuman(req, done) {
                    if (people[req.body.idCardNumber]) {
                        return utils.callAsync(done,
                                NefError('EEXIST', 'already exists'));
                    }
                    req.body.babies = {};
                    people[req.body.idCardNumber] = req.body;
                    utils.callAsync(done);
                },
                schemas: {
                    input: humanCreateSchema
                }
            },
            'delete': function deleteHuman(req, done) {
                if (!people[req.params.idCardNumber]) {
                    return utils.callAsync(done,
                            NefError('ENOENT', 'no such human'));
                }
                delete people[req.params.idCardNumber];
                utils.callAsync(done);
            },
            'makeHappy': {
                schemas: {
                    query: {
                        type: 'object',
                        properties: {
                            gift: {
                                type: 'string',
                                required: true,
                                enum: ['rotten apple', 'flower']
                            }
                        },
                        additionalProperties: false
                    },
                    output: {
                        type: 'object',
                        properties: {
                            likeIt: {type: 'boolean', required: true}
                        },
                        additionalProperties: false
                    }
                },
                handler: function makeHappyHuman(req, done) {
                    var res;

                    if (req.query.gift === 'rotten apple') {
                        res = {likeIt: false};
                    } else {
                        res = {likeIt: true};
                    }
                    utils.callAsync(done, null, res);
                }
            }
        }
    }, {
        id: 'babies',
        attachTo: {
            id: 'read_people',
            paramsMap: {
                'idCardNumber': 'parent'
            }
        },
        parentFields: {
            'read_people': ['name']
        },
        skipParentCheck: true,
        url: 'babies',
        key: 'id',
        description: 'Sub-collection of babies used for testing REST server',
        objectName: 'baby',
        objectSchema: babySchema,
        allowedZones: ['global', 'test'],
        querySchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                orderByAge: {
                    description: 'Sort result from oldest to youngest baby',
                    type: 'boolean',
                    default: false
                }
            }
        },
        asyncMethods: true, // creating baby takes time
        handler: function readAllBabies(req, done) {
            assert.strictEqual(typeof req.params.parent, 'number');
            var parent = people[req.params.parent];

            assert(parent, 'Request with invalid parent');
            assert(req.parents['read_people']['name'],
                    'Missing name of parent from parent check');

            var res = Object.keys(parent.babies).map(function(k) {
                var ret = utils.objectCopy(parent.babies[k]);
                delete ret.toys;
                return ret;
            });
            if (req.query.orderByAge) {
                res.sort(function(a, b) {
                    if (!a.born) {
                        return 1;
                    }
                    if (!b.born) {
                        return -1;
                    }
                    return (new Date(a.born) - new Date(b.born));
                });
            }
            delete req.query.orderByAge; // param already processed
            res = restUtils.filterResult(res, req.query,
                    ['limit', 'offset', 'fields']);
            res = restUtils.fitPage(req, res);
            utils.callAsync(done, null, res);
        },
        methods: {
            'read': function readBaby(req, done) {
                var parent = people[req.params.parent];
                var res;

                assert(req.parents['read_people']['name'],
                        'Missing name of parent from parent check');

                res = parent.babies[req.params.id];
                if (!res) {
                    utils.callAsync(done, NefError('ENOENT', 'no such baby'));
                } else {
                    res = utils.clone(res);
                    delete res.toys;
                    utils.callAsync(done, null, res);
                }
            },
            'create': {
                schemas: {
                    input: babyCreateSchema
                },
                handler: function createBaby(req, done) {
                    var parent = people[req.params.parent];
                    assert(parent, 'Request with invalid parent');

                    if (parent.babies[req.body.id]) {
                        return utils.callAsync(done,
                                NefError('EEXIST', 'baby already exists'));
                    }
                    if (req.body.born) {
                        var born = new Date(req.body.born);
                        if (born.toString() === 'Invalid Date') {
                            return utils.callAsync(done,
                                NefError('EFAILED', 'Invalid date'));
                        }
                        req.body.born = born.toISOString();
                    }
                    req.body.id = babyIdCounter++;
                    req.body.toys = {};

                    parent.babies[req.body.id] = req.body;
                    utils.callAsync(done);
                }
            },
            'delete': function deleteBaby(req, done) {
                var parent = people[req.params.parent];
                assert(parent, 'Request with invalid parent');

                if (!parent.babies[req.params.id]) {
                    return utils.callAsync(done,
                            NefError('ENOENT', 'no such baby'));
                }
                delete parent.babies[req.params.id];
                utils.callAsync(done);
            },
            // 'update' operation intentionally missing
        }
    }, {
        id: 'toys',
        attachTo: {
            id: 'read_babies',
            paramsMap: {
                'parent': 'babyParent',
                'id': 'baby'
            }
        },
        parentFields: {
            'read_people': ['name', 'age'],
            'read_babies': ['name']
        },
        url: 'toys',
        key: 'name',
        description: 'Sub-collection of toys of particular baby',
        objectName: 'toy',
        objectSchema: toySchema,
        allowedZones: ['global', 'test'],
        handler: function readAllToys(req, done) {
            assert.strictEqual(typeof req.params.babyParent, 'number');
            assert.strictEqual(typeof req.params.baby, 'number');
            var parent = people[req.params.babyParent];
            var baby = parent.babies[req.params.baby];

            // Baby can be undefined because skip-parent-check flag is
            // set to true for baby methods (for purpose of testing the
            // skip flag), so check it explicitly.
            if (!baby) {
                utils.callAsync(done,
                        NefError('ENOENT', 'Toy owner not found'));
                return;
            }
            var res = Object.keys(baby.toys).map(function(k) {
                return baby.toys[k];
            });
            res = restUtils.filterResult(res, req.query,
                    ['limit', 'offset', 'fields']);
            res = restUtils.fitPage(req, res);
            utils.callAsync(done, null, res);
        },
        methods: {
            'read': function readToy(req, done) {
                var parent = people[req.params.babyParent];
                var baby = parent.babies[req.params.baby];

                // Baby can be undefined because skip-parent-check flag is
                // set to true for baby methods (for purpose of testing the
                // skip flag), so check it explicitly.
                if (!baby) {
                    utils.callAsync(done,
                            NefError('ENOENT', 'Toy owner not found'));
                    return;
                }

                var toy = baby.toys[req.params.name];

                // check that parent check has been done in case of
                // people collection
                assert(req.parents['read_people'].name !== undefined);
                if (parent.age !== undefined) {
                    assert(req.parents['read_people'].age !== undefined);
                }

                if (!toy) {
                    utils.callAsync(done, NefError('ENOENT', 'no such toy'));
                } else {
                    utils.callAsync(done, null, toy);
                }
            },
            'create': function createToy(req, done) {
                var parent = people[req.params.babyParent];
                var baby = parent.babies[req.params.baby];
                assert(baby, 'Request with invalid baby');

                if (baby.toys[req.body.name]) {
                    return utils.callAsync(done,
                            NefError('EEXIST', 'toy already exists'));
                }
                baby.toys[req.body.name] = req.body;
                utils.callAsync(done);
            },
            'delete': function deleteToy(req, done) {
                var parent = people[req.params.babyParent];
                var baby = parent.babies[req.params.baby];
                assert(baby, 'Request with invalid baby');

                if (!baby.toys[req.params.name]) {
                    return utils.callAsync(done,
                            NefError('ENOENT', 'no such toy'));
                }
                delete baby.toys[req.params.name];
                utils.callAsync(done);
            }
        }
    }, {
        id: 'ages',
        url: '/test/ages',
        key: 'name',
        description: 'Versioned collection of ages',
        objectName: 'age',
        objectSchema: ageSchema,
        handler: function readAges(req, done) {
            data = [{
                fullName: 'Mr. Willam Eaton',
                nick: 'Willy',
                familySize: 5,
                friends: 16,
                toys: 32
            }, {
                fullName: 'Ms. Charlene Evans',
                nick: 'Charlie',
                familySize: 6,
                friends: 8,
                toys: 12
            }, {
                fullName: 'Mr. Timothy Bradford',
                nick: 'Tim',
                familySize: 4,
                friends: 12,
                toys: 18
            }];

            if (req.apiVersion.satisfies('1.2')) {
                data = data.map((el) => {
                    return {
                        name: el.fullName,
                        friends: el.friends,
                        familySize: el.familySize
                    };
                });
            } else if (req.apiVersion.satisfies('1.1')) {
                data = data.map((el) => {
                    return {
                        name: el.fullName.split(' ')[1],
                        friends: el.friends * 2,
                    };
                });
            } else {
                data = data.map((el) => {
                    return {
                        name: el.nick,
                        friends: el.friends / 4,
                        toys: el.toys
                    };
                });
            }
            utils.callAsync(done, null, data);
        },
        methods: []
    }],
    handlers: [{
        id: 'testValidation',
        action: 'update',
        url: '/test/validation/:str/:id',
        description: 'Test input validation',
        schemas: {
            input: {
                type: 'object',
                properties: {
                    attr: {
                        type: 'string',
                        maxLength: 10,
                        required: true
                    }
                },
                additionalProperties: false
            },
            query: {
                type: 'object',
                properties: {
                    param: {
                        type: 'boolean',
                        required: true,
                    }
                },
                additionalProperties: false
            },
            url: {
                type: 'object',
                properties: {
                    id: {
                        type: 'integer',
                        required: true,
                        minimum: 10,
                    },
                    str: {
                        type: 'string',
                        // intentional: all url params should be treated
                        // as required regardless this value
                        required: false
                    }
                },
                additionalProperties: false
            }
        },
        handler: function(req, done) {
            if (typeof req.body.attr !== 'string') {
                utils.callAsync(done, NefError('EFAILED',
                        __('attr is not a string')));
                return;
            }
            if (typeof req.query.param !== 'boolean') {
                utils.callAsync(done, NefError('EFAILED',
                        __('query param is not a boolean')));
                return;
            }
            if (typeof req.params.str !== 'string' ||
                    req.params.str.length === 0) {
                utils.callAsync(done, NefError('EFAILED',
                        __('str is not non-empty string')));
                return;
            }
            if (typeof req.params.id !== 'number') {
                utils.callAsync(done, NefError('EFAILED',
                        __('id is not a number')));
                return;
            }
            utils.callAsync(done); // no-op
        }
    }, {
        id: 'testMissingWorker',
        action: 'read',
        url: '/test/missingWorker',
        description: 'Test status code when worker does not run',
        handler: function(req, done) {
            interop.call('worker-XXX', 'method', {}, done);
        }
    }, {
        id: 'uncaughtException',
        action: 'read',
        url: '/test/uncaughtException',
        description: 'Test status code in case of unhandled exception ' +
                'in REST server',
        handler: function(req, done) {
            // intentionally reference undefined variable
            done(undefined, undefinedVariableInRestServer);
        }
    }, {
        id: 'testAsyncUpdate',
        action: 'update',
        async: true,
        url: '/test/async',
        description: 'Run async update with progress information updated ' +
                'every second',
        schemas: {query: asyncOpQuerySchema},
        handler: function(req, done, progressCb) {
            asyncOpBody(req.query.delay, progressCb, done);
        }
    }, {
        id: 'testAsyncCreate',
        action: 'create',
        async: true,
        url: '/test/async',
        description: 'Run async create with progress information updated ' +
                'every second',
        schemas: {query: asyncOpQuerySchema},
        handler: function(req, done, progressCb) {
            req.responseStatus = 201;
            asyncOpBody(req.query.delay, progressCb, done);
        }
    }, {
        id: 'testAsyncDelete',
        action: 'delete',
        async: true,
        url: '/test/async',
        description: 'Run async delete with progress information updated ' +
                'every second',
        schemas: {query: asyncOpQuerySchema},
        handler: function(req, done, progressCb) {
            asyncOpBody(req.query.delay, progressCb, done);
        }
    }, {
        id: 'testDeferredAsyncCreate',
        action: 'create',
        async: true,
        deferredAsync: true,
        url: '/test/deferredAsync',
        description: 'Run async create with deferred 202 reply with progress ' +
                'information updated every second',
        schemas: {
            query: {
                type: 'object',
                properties: {
                    delay: {type: 'integer'},
                    error: {type: 'boolean', default: false}
                }
            }
        },
        handler: function(req, done, progressCb, asyncDone) {
            if (req.query.error) {
                utils.callAsync(done, new NefError('EFAILED',
                    __('An error occured before transitioning to async mode')));
                return;
            }
            req.responseStatus = 201;
            utils.callAsync(function() {
                asyncDone({payload: '202 reply payload'});
                utils.callAsync(function() {
                    asyncOpBody(req.query.delay, progressCb, done);
                });
            });
        }
    }, {
        id: 'peopleProxy',
        attachTo: {
            id: 'read_people',
            paramsMap: {
                'idCardNumber': 'parent'
            }
        },
        action: 'read',
        url: 'proxy',
        urlProxy: true,
        description: 'Return proxied path and query parameters as seen ' +
                'by the handler',
        schemas: {
            query: {
                type: 'object',
                properties: {
                    rawQuery: {
                        description: 'Raw query string for the method for ' +
                                'purpose of being able to specify query ' +
                                'parameters in swagger',
                        type: 'string'
                    }
                }
            },
            output: {
                type: 'object'
            }
        },
        handler: function(req, done) {
            utils.callAsync(done, null, {
                data: {
                    params: req.params,
                    query: req.query
                }
            });
        }
    }, {
        id: 'testProtectedEndpoint',
        action: 'read',
        url: '/test/protected',
        description: 'Provides access only to "admin" user level',
        accessLevel: 'admin',
        schemas: {
            output: {
                type: 'object'
            }
        },
        handler: function(req, done) {
            done(null, {message: 'Access granted'});
        }
    }]
};

// Disable endpoints in production environment
if (!commonConfig['testEndpoints']) {
    module.exports = {
        name: 'Test API',
        version: '1.0.0',
        collections: []
    };
}
