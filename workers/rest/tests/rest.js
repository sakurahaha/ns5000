/*
 * REST API tests.
 *
 * Copyright (C) 2014 Nexenta Systems, Inc
 * All rights reserved.
 */

var chai = require('chai');
var assert = chai.assert;
var expect = chai.expect;
var async = require('async');
var restify = require('restify');
var http = require('http');
var nefUtils = require('nef/utils');
var aux = require('nef/testHelpers');
var interop = require('nef/interop');
var restTestHelpers = require('nef/restTestHelpers');

var restConfig = nefUtils.requireConfig('config/rest');

chai.use(require('chai-datetime'));

function setInstancePropAndWait(propId, value, done) {
    var origValue;

    async.series([
        (next) => {
            interop.call('sysconfig', 'getProperty', {
                id: propId
            }, (err, res) => {
                assert.ifError(err);
                origValue = res;
                next();
            });
        },
        (next) => {
            if (origValue == value) {
                return next();
            }

            aux.waitEvent({
                event: 'NEF_rest_configuration_updated',
                message: 'Wait to property to be applied',
                timeout: 60000,
                prepare: (next) => {
                    interop.call('sysconfig', 'setProperty', {
                        id: propId,
                        value: value
                    }, next);
                }
            }, next);
        }
    ], done);
}

function setUseSwagger(value, done) {
    setInstancePropAndWait('worker.rest.useSwagger', value, done);
}

function setManagementAddress(value, done) {
    setInstancePropAndWait('worker.rest.managementAddress', value, done);
}

function checkAccess(client, statusCode, done) {
    aux.wait({
        timeout: 30000,
        message: 'Wait for access check',
        callback: function(cb) {
            client.get('/', function(err, req, res, obj) {
                var terminate = true;

                if (err) {
                    if (err.code === 'ECONNREFUSED') {
                        err = null;
                        terminate = false;
                    } else if (res && res.statusCode == statusCode) {
                        err = null;
                    } else {
                        err = new Error('Unexpected error: ' +
                                err.toString());
                    }
                }
                cb(err, terminate);
            });
        }
    }, done);
}

function setHttpsProtocol(value, done) {
    setInstancePropAndWait('worker.rest.httpsProtocol', value, done);
}

describe('REST core', function() {
    var self = this;
    var jsonClient;
    var localhost = '127.0.0.1';
    var port = restConfig.localPort;
    var url = 'http://' + localhost + ':' + port;

    nefUtils.extend(self, require('nef/restTestHelpers'));

    aux.initSuite(self, {
        tag: 'vm'
    });

    before(function(done) {
        jsonClient = restify.createJSONClient({
            url: url,
            rejectUnauthorized: false,
            version: '*'
        });
        done();
    });

    describe('/test', function() {

        /**
         * Returns a jsonClient compatible callback function which waits for
         * result of async request and calls provided callback with resulting
         * arguments (as if async op was a sync op).
         */
        function assertedAsyncDecorator(interval, done, progressCb) {
            var handler = function(err, req, res, data) {
                assert.ifError(err);
                expect(res).to.have.status(202);
                expect(self.getLinkCount(data, 'monitor')).to.equal(1);

                var monitorHref = self.getLink(data, 'monitor');
                var jobId = monitorHref.slice(monitorHref.lastIndexOf('/') + 1);
                var end;

                async.whilst(
                    function() { return !end; },
                    function(next) {
                        jsonClient.get(monitorHref,
                                function(err, req, res, data) {

                            if (!res) {
                                // low level error
                                assert.ifError(err);
                            }

                            if (res.statusCode === 202) {
                                // continue polling
                                expect(self.getLinkCount(data, 'monitor'))
                                    .to.equal(1);
                                expect(self.getLink(data, 'monitor'))
                                    .to.equal(monitorHref);
                                expect(monitorHref).to.contain(data.jobId);
                                expect(data.originalMethod).to.exist;
                                expect(data.originalUrl).to.exist;
                                expect(new Date(data.startTime))
                                        .to.be.beforeTime(new Date());
                                expect(data.finishTime).to.be.undefined;
                                expect(data.done).to.be.false;
                                if (data.progress !== undefined && progressCb) {
                                    progressCb(data.progress);
                                }
                                setTimeout(next, interval);
                                return;
                            }
                            // got something
                            res.jobId = jobId;
                            end = function() {done(err, req, res, data);};
                            next();
                        });
                    },
                    function(err) {
                        if (err) {
                            done(err);
                            return;
                        }
                        end();
                    });
            };
            return handler;
        }

        /**
         * Delete all entries from people collection.
         */
        function clearPeople(done) {
            jsonClient.get('/test/people', function(err, req, res, data) {
                assert.ifError(err);
                expect(res).to.have.status(200);

                async.each(data.data, function(ent, next) {
                    jsonClient.del(ent.href, function(err, req, res, data) {
                        assert.ifError(err);
                        expect(res).to.have.status(200);
                        next();
                    });
                }, done);
            });
        }

        describe('return codes', function() {

            it('should return ENOENT if resource does not exist', function(done) {
                jsonClient.get('/test/not/exist', function(err, req, res, data) {
                    expect(err).to.exist;
                    expect(res).to.have.status(404);
                    expect(data.name).to.equal('NefError');
                    expect(data.code).to.equal('ENOENT');
                    expect(data.message).to.exist;
                    expect(data.stack).to.exist;
                    done();
                });
            });

            it('should return EACCES if method is not allowed', function(done) {
                jsonClient.put('/test/people', {}, function(err, req, res, data) {
                    expect(err).to.exist;
                    expect(res).to.have.status(405);
                    expect(data.name).to.equal('NefError');
                    expect(data.code).to.equal('EACCES');
                    expect(data.message).to.exist;
                    expect(data.stack).to.exist;
                    done();
                });
            });

            it('should return 400 for body in GET method', function(done) {
                // Use low-level http lib because restify does not allow us to send
                // body in GET method.
                var data = '{"msg": "hello"}';
                var options = {
                    hostname: localhost,
                    port: port,
                    method: 'GET',
                    path: '/test/people',
                    agent: false,  // prevent keep-alive
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': data.length
                    }
                };
                var req = http.request(options, function(res) {
                    expect(res).to.have.status(400);
                    done();
                });
                req.on('error', function(e) {
                    done(e);
                });
                req.write(data);
                req.end();
            });

            it('should return 400 for body in DELETE method', function(done) {
                // Use low-level http lib because restify does not allow us to send
                // body in DELETE method.
                var data = '{"msg": "hello"}';
                var options = {
                    hostname: localhost,
                    port: port,
                    method: 'DELETE',
                    path: '/test/people/1',
                    agent: false,  // prevent keep-alive
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': data.length
                    }
                };
                var req = http.request(options, function(res) {
                    expect(res).to.have.status(400);
                    done();
                });
                req.on('error', function(e) {
                    done(e);
                });
                req.write(data);
                req.end();
            });

            it('should return ENOENT for unsupported method version',
                    function(done) {
                var jsonClient = restify.createJSONClient({
                    url: url,
                    rejectUnauthorized: false,
                    version: '2.0.0',
                    agent: false   // prevent keep-alive
                });
                jsonClient.get('/test/people', function(err, req, res, data) {
                    expect(err).to.exist;
                    expect(res).to.have.status(404);
                    expect(data.name).to.equal('NefError');
                    expect(data.code).to.equal('ENOENT');
                    expect(data.message).to.exist;
                    expect(data.stack).to.exist;
                    done();
                });
            });

            it('should return EUNKNOWN for uncaught exception', function(done) {
                // Unhandled exception causes the REST server to close the
                // connection, which makes the subsequent test to fail. So we
                // dedicated a separate json client for this test.
                var jsonClient = restify.createJSONClient({
                    url: url,
                    rejectUnauthorized: false,
                    version: '*',
                    agent: false   // prevent keep-alive
                });

                jsonClient.get('/test/uncaughtException',
                        function(err, req, res, data) {
                    expect(err).to.exist;
                    expect(res).to.have.status(500);
                    expect(data.name).to.equal('NefError');
                    expect(data.code).to.equal('EUNKNOWN');
                    expect(data.message).to.exist;
                    expect(data.stack).to.exist;
                    done();
                });
            });

            it('should browse resources through meta-data links', function(done) {
                var humanUrl;
                var babyUrl;
                var toyUrl;

                /*
                 * Navigate from "/" to "/test/people/1/babies"
                 */
                async.series([
                    clearPeople,
                    function(next) {
                        jsonClient.get('/', function(err, req, res, data) {
                            assert.ifError(err);
                            expect(res).to.have.status(200);
                            expect(self.getLink(data, 'self')).to.equal('/');
                            expect(self.getLink(data, 'collection/people'))
                                    .to.equal('/test/people');
                            next();
                        });
                    },
                    function(next) {
                        jsonClient.post('/test/people', {
                            idCardNumber: 1,
                            name: 'Jara Cimrman',
                            age: 65
                        }, next);
                    },
                    function(next) {
                        jsonClient.get('/test/people',
                                function(err, req, res, data) {
                            assert.ifError(err);
                            expect(res).to.have.status(200);
                            expect(self.getLink(data, 'self'))
                                    .to.equal('/test/people');
                            expect(self.getLink(data, 'parent')).to.be.undefined;
                            humanUrl = data.data[0].href;
                            next();
                        });
                    },
                    function(next) {
                        jsonClient.get(humanUrl, function(err, req, res, data) {
                            assert.ifError(err);
                            expect(res).to.have.status(200);
                            expect(self.getLink(data, 'self'))
                                    .to.equal(humanUrl);
                            expect(self.getLink(data, 'collection'))
                                    .to.equal('/test/people');
                            expect(self.getLink(data, 'collection/babies'))
                                    .to.equal(humanUrl + '/babies');
                            next();
                        });
                    },
                    function(next) {
                        jsonClient.post(humanUrl + '/babies', {
                            name: 'Enzo Ferrari'
                        }, assertedAsyncDecorator(1000,
                                function(err, req, res, data) {
                            assert.ifError(err);
                            expect(res).to.have.status(201);
                            babyUrl = res.headers['location'];
                            next();
                        }));
                    },
                    function(next) {
                        jsonClient.get(humanUrl + '/babies',
                                function(err, req, res, data) {
                            assert.ifError(err);
                            expect(res).to.have.status(200);
                            expect(self.getLink(data, 'self'))
                                    .to.equal(humanUrl + '/babies');
                            expect(self.getLink(data, 'parent'))
                                    .to.equal(humanUrl);
                            expect(self.getLink(data, 'action/create'))
                                    .to.equal(humanUrl + '/babies');
                            next();
                        });
                    },
                    function(next) {
                        jsonClient.get(babyUrl, function(err, req, res, data) {
                            assert.ifError(err);
                            expect(res).to.have.status(200);
                            expect(self.getLink(data, 'self')).to.equal(babyUrl);
                            expect(self.getLink(data, 'collection'))
                                    .to.equal(humanUrl + '/babies');
                            expect(self.getLink(data, 'collection/toys'))
                                    .to.equal(babyUrl + '/toys');
                            next();
                        });
                    },
                    function(next) {
                        jsonClient.post(babyUrl + '/toys', {
                            name: 'ball'
                        }, function(err, req, res, data) {
                            assert.ifError(err);
                            expect(res).to.have.status(201);
                            toyUrl = res.headers['location'];
                            next();
                        });
                    },
                    function(next) {
                        jsonClient.get(babyUrl + '/toys',
                                function(err, req, res, data) {
                            assert.ifError(err);
                            expect(res).to.have.status(200);
                            expect(self.getLink(data, 'self'))
                                    .to.equal(babyUrl + '/toys');
                            expect(self.getLink(data, 'parent'))
                                    .to.equal(babyUrl);
                            expect(self.getLink(data, 'action/create'))
                                    .to.equal(babyUrl + '/toys');
                            expect(data.data).to.have.length(1);
                            expect(data.data[0].href).to.equal(toyUrl);
                            next();
                        });
                    },
                    function(next) {
                        jsonClient.get(toyUrl, function(err, req, res, data) {
                            assert.ifError(err);
                            expect(res).to.have.status(200);
                            expect(self.getLink(data, 'self')).to.equal(toyUrl);
                            expect(self.getLink(data, 'collection'))
                                    .to.equal(babyUrl + '/toys');
                            expect(self.getLink(data, 'action/delete'))
                                    .to.equal(toyUrl);
                            next();
                        });
                    },
                    function(next) {
                        jsonClient.del(toyUrl, function(err, req, res, data) {
                            assert.ifError(err);
                            expect(res).to.have.status(200);
                            next();
                        });
                    },
                    function(next) {
                        jsonClient.del(humanUrl, function(err, req, res, data) {
                            assert.ifError(err);
                            expect(res).to.have.status(200);
                            next();
                        });
                    },
                    // now when parent was deleted, request for baby should
                    // return ENOENT
                    function(next) {
                        jsonClient.get(babyUrl, function(err, req, res, data) {
                            expect(res).to.have.status(404);
                            next();
                        });
                    },
                ], done);
            });

            it('should return HTTP status 500 if backend worker does not run',
                    function(done) {
                jsonClient.get('/test/missingWorker',
                        function(err, req, res, data) {
                    expect(res).to.have.status(500);
                    expect(data.code).to.equal('ESRCH');
                    done();
                });
            });
        });

        describe('collection operations', function() {
            var newHref;
            var n = 100;

            // make sure we start with empty collection
            before(clearPeople);
            after(clearPeople);

            it('should create new entry', function(done) {
                jsonClient.post('/test/people', {
                    idCardNumber: 1,
                    name: 'Jan Kryl',
                    age: 33,
                }, function(err, req, res, data) {
                    assert.ifError(err);
                    expect(res).to.have.status(201);
                    newHref = res.headers['location'];
                    expect(newHref).to.equal('/test/people/1');
                    expect(data).to.be.empty;
                    done();
                });
            });

            it('should get detail of entry', function(done) {
                jsonClient.get(newHref, function(err, req, res, data) {
                    assert.ifError(err);
                    expect(res).to.have.status(200);
                    // meta data
                    expect(self.getLinkCount(data, 'self')).to.equal(1);
                    expect(self.getLink(data, 'self'))
                            .to.equal('/test/people/1');
                    expect(self.getLinkCount(data, 'collection'))
                            .to.equal(1);
                    expect(self.getLink(data, 'collection'))
                            .to.equal('/test/people');
                    expect(self.getLinkCount(data, 'collection/babies'))
                            .to.equal(1);
                    expect(self.getLink(data, 'collection/babies'))
                            .to.equal('/test/people/1/babies');
                    expect(self.getLinkCount(data, 'action/makeHappy'))
                            .to.equal(1);
                    expect(self.getLink(data, 'action/makeHappy'))
                            .to.equal('/test/people/1/makeHappy');
                    expect(self.getLinkMethod(data, 'action/makeHappy'))
                            .to.equal('POST');
                    expect(self.getLinkCount(data, 'action/delete'))
                            .to.equal(1);
                    expect(self.getLink(data, 'action/delete'))
                            .to.equal('/test/people/1');
                    expect(self.getLinkMethod(data, 'action/delete'))
                            .to.equal('DELETE');
                    expect(self.getLinkCount(data, 'action/update'))
                            .to.equal(1);
                    expect(self.getLink(data, 'action/update'))
                            .to.equal('/test/people/1');
                    expect(self.getLinkMethod(data, 'action/update'))
                            .to.equal('PUT');
                    expect(self.getLinkCount(data, 'monitor')).to.equal(0);
                    expect(self.getLinkCount(data, 'next')).to.equal(0);
                    expect(self.getLinkCount(data, 'prev')).to.equal(0);
                    expect(self.getLinkCount(data, 'parent')).to.equal(0);
                    expect(res.headers['location']).to.be.undefined;
                    expect(data.href).to.be.undefined;
                    // data
                    expect(data.idCardNumber).to.equal(1);
                    expect(data.name).to.equal('Jan Kryl');
                    expect(data.age).to.equal(33);
                    expect(data.married).to.be.false;
                    done();
                });
            });

            it('should filter fields of entry detail', function(done) {
                jsonClient.get(newHref + '?fields=name,age',
                        function(err, req, res, data) {
                    assert.ifError(err);
                    expect(res).to.have.status(200);
                    expect(data.idCardNumber).to.be.undefined;
                    expect(data.name).to.equal('Jan Kryl');
                    expect(data.age).to.equal(33);
                    done();
                });
            });

            it('should update entry', function(done) {
                jsonClient.put(newHref, {
                    // "age" should be removed
                    married: true,
                }, function(err, req, res, data) {
                    assert.ifError(err);
                    expect(res).to.have.status(200);
                    expect(res.headers['location']).to.be.undefined;
                    expect(data).to.be.empty;
                    jsonClient.get(newHref, function(err, req, res, data) {
                        assert.ifError(err);
                        expect(data.age).to.equal(undefined);
                        expect(data.married).to.be.true;
                        done();
                    });
                });
            });

            it('should get headers of method', function(done) {
                jsonClient.head(newHref, function(err, req, res, data) {
                    assert.ifError(err);
                    expect(res).to.have.status(200);
                    expect(res.headers['location']).to.be.undefined;
                    expect(res.headers['access-control-allow-methods']
                            .split(', '))
                            .to.have.members(['GET', 'HEAD', 'PUT', 'DELETE']);
                    expect(data).to.be.empty;
                    done();
                });
            });

            it('should call special action with query parameter',
                    function(done) {
                jsonClient.post(newHref + '/makeHappy?gift=' +
                        encodeURIComponent('rotten apple'), null,
                        function(err, req, res, data) {
                    assert.ifError(err);
                    expect(res).to.have.status(200);
                    expect(data.likeIt).to.be.false;
                    done();
                });
            });

            it('should read collection', function(done) {
                // populate collection
                function populateCollection(i, done) {
                    async.whilst(
                        function() { return i > 1; },
                        function(next) {
                            jsonClient.post('/test/people', {
                                idCardNumber: i,
                                name: 'Jan K' + i,
                            }, function(err, req, res, data) {
                                assert.ifError(err);
                                expect(res).to.have.status(201);
                                i--;
                                next();
                            });
                        },
                        function(err) {
                            assert.ifError(err);
                            done();
                        });
                }

                populateCollection(n, function() {
                    var offset = 0;
                    var notEnd = true;
                    var total = 0;
                    // Edge case, page boundary = coll boundary
                    var limit = n / 10;

                    // read one page after another
                    async.whilst(
                        function() { return notEnd; },
                        function(next) {
                            var url = '/test/people?offset=' + offset +
                                    '&limit=' + limit +
                                    '&fields=name,married,idCardNumber' +
                                    '&married=false';

                            jsonClient.get(url, function(err, req, res, data) {
                                assert.ifError(err);
                                expect(res).to.have.status(200);
                                expect(self.getLinkCount(data, 'self'))
                                        .to.equal(1);
                                expect(self.getLink(data, 'self'))
                                        .to.equal(url);
                                expect(self.getLinkCount(data, 'action/create'))
                                        .to.equal(1);
                                expect(self.getLink(data, 'action/create'))
                                        .to.equal('/test/people');
                                expect(self.getLinkMethod(data,
                                        'action/create')).to.equal('POST');
                                expect(self.getLinkCount(data, 'monitor'))
                                        .to.equal(0);
                                expect(self.getLinkCount(data, 'collection'))
                                        .to.equal(0);
                                expect(self.getLinkCount(data,
                                        'collection/babies')).to.equal(0);
                                expect(self.getLinkCount(data, 'parent'))
                                        .to.equal(0);

                                if (offset === 0) {
                                    expect(self.getLinkCount(data, 'prev'))
                                            .to.equal(0);
                                } else {
                                    expect(self.getLinkCount(data, 'prev'))
                                            .to.equal(1);
                                    expect(self.getLink(data, 'prev'))
                                            .to.equal(
                                            '/test/people?offset=' +
                                            (offset - limit) +
                                            '&limit=' + limit +
                                            '&fields=name,married,' +
                                            'idCardNumber&married=false');
                                }

                                data.data.forEach(function(e) {
                                    expect(e.href).to.exist;
                                    expect(e.href).to.contain('/test/people/');
                                    expect(Object.keys(e)).to.have.length(4);
                                });
                                total += data.data.length;
                                if (total >= n - 1) {
                                    expect(self.getLinkCount(data, 'next'))
                                            .to.equal(0);
                                    notEnd = false;
                                    return next();
                                }
                                offset += limit;
                                expect(self.getLinkCount(data, 'next'))
                                        .to.equal(1);
                                expect(self.getLink(data, 'next'))
                                        .to.equal('/test/people?offset=' +
                                        offset + '&limit=' + limit +
                                        '&fields=name,married,idCardNumber' +
                                        '&married=false');
                                expect(data.data).to.have.length(limit);
                                next();
                            });
                        },
                        function(err) {
                            assert.ifError(err);
                            // married = false -> 2..100
                            expect(total).to.equal(n - 1);
                            done();
                        });
                });
            });

            it('should browse collection by next and prev metadata links',
                    function(done) {
                var limit = 9;
                var nextHref = '/test/people?limit=' + limit + '&married=false';
                var prevHref;
                var total = 0;
                var first = true;

                // surf forward
                async.whilst(
                    function() { return nextHref; },
                    function(next) {
                        jsonClient.get(nextHref, function(err, req, res, data) {
                            assert.ifError(err);
                            expect(res).to.have.status(200);

                            if (first) {
                                first = false;
                            } else {
                                expect(self.getLinkCount(data, 'prev'))
                                        .to.equal(1);
                            }

                            total += data.data.length;
                            nextHref = self.getLink(data, 'next');
                            if (self.getLinkCount(data, 'next') === 1) {
                                // go to the next page
                                return next();
                            }
                            expect(self.getLinkCount(data, 'next'))
                                    .to.equal(0);
                            prevHref = self.getLink(data, 'self');
                            next();
                        });
                    },
                    function(err) {
                        assert.ifError(err);
                        // married = false -> 2..100
                        expect(total).to.equal(n - 1);
                        expect(prevHref).to.exist;
                        var first = true;

                        // surf backward
                        async.whilst(
                            function() { return prevHref; },
                            function(next) {
                                jsonClient.get(prevHref,
                                        function(err, req, res, data) {
                                    assert.ifError(err);
                                    expect(res).to.have.status(200);
                                    expect(self.getLinkCount(data, 'self'))
                                            .to.equal(1);
                                    expect(self.getLink(data, 'self'))
                                            .to.equal(prevHref);

                                    if (first) {
                                        first = false;
                                    } else {
                                        expect(self.getLinkCount(data, 'next'))
                                                .to.equal(1);
                                    }

                                    total -= data.data.length;
                                    prevHref = self.getLink(data, 'prev');
                                    if (self.getLinkCount(data, 'prev') === 1) {
                                        // go to the prev page
                                        return next();
                                    }
                                    expect(self.getLinkCount(data, 'prev'))
                                            .to.equal(0);
                                    next();
                                });
                            },
                            function(err) {
                                assert.ifError(err);
                                expect(total).to.equal(0);
                                done();
                            });
                    });
            });

            it('should not update read-only property', function(done) {
                jsonClient.put(newHref, {
                    name: 'Karel Kryl',
                    age: 34,
                    married: true,
                }, function(err, req, res, data) {
                    expect(err).to.exist;
                    expect(res).to.have.status(400);
                    expect(data.code).to.equal('EBADARG');
                    expect(data.message).to.exist;
                    done();
                });
            });

            it('should delete an entry', function(done) {
                jsonClient.del(newHref, function(err, req, res, data) {
                    assert.ifError(err);
                    expect(res).to.have.status(200);
                    expect(res.headers['location']).not.to.exist;
                    expect(data).to.equal;

                    // verify it's gone
                    jsonClient.get(newHref, function(err, req, res, data) {
                        expect(res).to.have.status(404);
                        done();
                    });
                });
            });
        });

        describe('async collection operations', function() {
            var hrefBabies;
            var hrefParent;
            var hrefBaby;
            var born = new Date();

            // make sure we start with empty collection
            before(clearPeople);
            after(clearPeople);

            it('should create babies', function(done) {
                // first create parent
                jsonClient.post('/test/people', {
                    idCardNumber: 1,
                    name: 'Jan Kryl',
                    age: 33,
                }, function(err, req, res, data) {
                    assert.ifError(err);
                    expect(res).to.have.status(201);
                    hrefParent = res.headers['location'];
                    jsonClient.get(hrefParent, function(err, req, res, data) {
                        assert.ifError(err);
                        expect(res).to.have.status(200);
                        expect(self.getLinkCount(data, 'collection/babies'))
                                .to.equal(1);
                        hrefBabies = self.getLink(data, 'collection/babies');
                        // now we can create babies
                        async.eachSeries([{
                            name: 'Karel',
                            born: new Date()
                        }, {
                            name: 'Nick'
                        }, {
                            name: 'Michael',
                            born: born
                        }], function(baby, next) {
                            jsonClient.post(hrefBabies, {
                                name: baby.name,
                                born: baby.born
                            }, assertedAsyncDecorator(1000,
                                    function(err, req, res, data) {
                                assert.ifError(err);
                                expect(res).to.have.status(201);
                                hrefBaby = res.headers['location'];
                                var components = hrefBaby.split('/');
                                expect(components[0]).to.equal('');
                                expect(components[1]).to.equal('test');
                                expect(components[2]).to.equal('people');
                                expect(components[3]).to.equal('1');
                                expect(components[4]).to.equal('babies');
                                expect(isFinite(components[5])).to.be.true;
                                expect(data).to.be.empty;
                                next();
                            }));
                        }, done);
                    });
                });
            });

            it('should get all babies sorted by age', function(done) {
                jsonClient.get(hrefBabies + '?orderByAge=true',
                        function(err, req, res, data) {
                    assert.ifError(err);
                    // GET should never be 202
                    expect(res).to.have.status(200);
                    expect(self.getLinkCount(data, 'parent')).to.equal(1);
                    expect(self.getLink(data, 'parent'))
                            .to.equal(hrefParent);
                    expect(data.data).to.have.length(3);
                    expect(data.data[0].name).to.equal('Michael');
                    expect(new Date(data.data[0].born)).to.equalTime(born);
                    expect(data.data[1].name).to.equal('Karel');
                    expect(new Date(data.data[1].born))
                            .to.be.beforeTime(new Date());
                    expect(data.data[2].name).to.equal('Nick');
                    expect(data.data[2].born).to.be.undefined;
                    done();
                });
            });

            it('should get baby detail', function(done) {
                jsonClient.get(hrefBaby, function(err, req, res, data) {
                    assert.ifError(err);
                    // GET should never be 202
                    expect(res).to.have.status(200);
                    expect(hrefBaby).to.contain(data.id);
                    expect(data.name).to.equal('Michael');
                    expect(new Date(data.born)).to.equalTime(born);
                    expect(self.getLinkCount(data, 'self')).to.equal(1);
                    expect(self.getLink(data, 'self')).to.equal(hrefBaby);
                    expect(self.getLinkCount(data, 'collection'))
                            .to.equal(1);
                    expect(self.getLink(data, 'collection'))
                            .to.equal(hrefBabies);
                    expect(self.getLinkCount(data, 'collection/babies'))
                            .to.equal(0);
                    expect(self.getLinkCount(data, 'monitor')).to.equal(0);
                    expect(self.getLinkCount(data, 'next')).to.equal(0);
                    expect(self.getLinkCount(data, 'prev')).to.equal(0);
                    expect(res.headers['location']).to.be.undefined;
                    expect(data.href).to.be.undefined;
                    done();
                });
            });

            it('should not list babies of non-existing parent', function(done) {
                jsonClient.get('/test/people/555/babies',
                        function(err, req, res, data) {
                    expect(res).to.have.status(404);
                    // Parent check is active so the error message should come
                    // from read handler of people collection.
                    expect(data.message).to.have.string('no such human');
                    done();
                });
            });

            it('should not get a toy of non-existing parent', function(done) {
                jsonClient.get('/test/people/555/babies/1/toys/car',
                        function(err, req, res, data) {
                    expect(res).to.have.status(404);
                    // Parent check is active so the error message should come
                    // from read handler of people collection.
                    expect(data.message)
                            .to.have.string('no such human');
                    done();
                });
            });

            it('should not get a toy of non-existing baby', function(done) {
                jsonClient.get(hrefParent + '/babies/99/toys/car',
                        function(err, req, res, data) {
                    expect(res).to.have.status(404);
                    // Parent check is skipped in case of baby collection so
                    // we test for exact match of the message generated from
                    // toy read handler to make sure ENOENT is generated from
                    // there and from nowhere else.
                    expect(data.message).to.have.string('Toy owner not found');
                    done();
                });
            });

            it('should not get baby detail with incorrect query parameter',
                    function(done) {
                jsonClient.get(hrefBaby + '?orderByAge=false',
                        function(err, req, res, data) {
                    expect(res).to.have.status(400);
                    done();
                });
            });

            it('should not update the baby', function(done) {
                jsonClient.put(hrefBaby, function(err, req, res, data) {
                    // update method for baby is not defined
                    expect(res).to.have.status(405);
                    done();
                });
            });

            it('should delete the baby', function(done) {
                jsonClient.del(hrefBaby, assertedAsyncDecorator(1000,
                        function(err, req, res, data) {
                    assert.ifError(err);
                    expect(res).to.have.status(200);
                    expect(data).to.be.empty;
                    done();
                }));
            });

            it('should not delete baby which does not exist', function(done) {
                jsonClient.del(hrefBaby, assertedAsyncDecorator(1000,
                        function(err, req, res, data) {
                    expect(res).to.have.status(404);
                    done();
                }));
            });
        });

        describe('input validation', function() {
            it('should pass if parameters are valid', function(done) {
                jsonClient.put('/test/validation/cheers/10?param=True', {
                    attr: 'something'
                }, function(err, req, res, data) {
                    expect(res).to.have.status(200);
                    done();
                });
            });

            it('should return error if payload is invalid', function(done) {
                jsonClient.put('/test/validation/cheers/10?param=true', {
                    attr: 'something-very-long'
                }, function(err, req, res, data) {
                    expect(res).to.have.status(400);
                    expect(data.code).to.equal('EBADARG');
                    done();
                });
            });

            it('should return error if payload is missing', function(done) {
                jsonClient.put('/test/validation/cheers/10?param=true', null,
                        function(err, req, res, data) {
                    expect(res).to.have.status(400);
                    expect(data.code).to.equal('EBADARG');
                    done();
                });
            });

            it('should return error if required query parameter is missing',
                    function(done) {
                jsonClient.put('/test/validation/cheers/10', {
                    attr: 'something'
                }, function(err, req, res, data) {
                    expect(res).to.have.status(400);
                    expect(data.code).to.equal('EBADARG');
                    done();
                });
            });

            it('should return error if query parameter is not known',
                    function(done) {
                jsonClient.put('/test/validation/cheers/10' +
                    '?param=true,param2=123', {attr: 'something'},
                    function(err, req, res, data) {
                        expect(res).to.have.status(400);
                        expect(data.code).to.equal('EBADARG');
                        done();
                    });
            });

            it('should return error if URL parameter is invalid',
                    function(done) {
                jsonClient.put('/test/validation/cheers/str?param=true', {
                    attr: 'something'
                }, function(err, req, res, data) {
                    expect(res).to.have.status(400);
                    expect(data.code).to.equal('EBADARG');
                    done();
                });
            });

            it('should return error if URL parameter is empty', function(done) {
                jsonClient.put('/test/validation//10?param=true', {
                    attr: 'something'
                }, function(err, req, res, data) {
                    expect(res).to.have.status(400);
                    expect(data.code).to.equal('EBADARG');
                    done();
                });
            });
        });

        describe('async operation', function() {
            var jobIds = [];

            aux.skipKnown(this, 'NEX-20358');

            it('POST', function(done) {
                var progCounter = 0;
                var lastProg = -1;

                aux.longJob('long async operation', function(done) {
                    jsonClient.post('/test/async?delay=3', {},
                        assertedAsyncDecorator(800,
                                function(err, req, res, data) {
                            expect(res).to.have.status(201);
                            expect(progCounter).to.equal(4);
                            expect(lastProg).to.equal(2);
                            jobIds.push(res.jobId);
                            done();
                        },
                        function(prog) {
                            // prog is increasing every second until 5
                            expect(lastProg).to.be.most(prog);
                            lastProg = prog;
                            progCounter++;
                        }));
                }, done);
            });

            it('PUT', function(done) {
                var progCounter = 0;
                var lastProg = -1;

                aux.longJob('long async operation', function(done) {
                    jsonClient.put('/test/async?delay=3', {},
                        assertedAsyncDecorator(800,
                        function(err, req, res, data) {
                            expect(err).to.be.success;
                            expect(res).to.have.status(200);
                            expect(progCounter).to.equal(4);
                            expect(lastProg).to.equal(2);
                            jobIds.push(res.jobId);
                            done();
                        },
                        function(prog) {
                            // prog is increasing every second until 3
                            expect(lastProg).to.be.most(prog);
                            lastProg = prog;
                            progCounter++;
                        }));
                }, done);
            });

            it('DELETE', function(done) {
                var progCounter = 0;
                var lastProg = -1;

                aux.longJob('long async operation', function(done) {
                    jsonClient.del('/test/async?delay=3',
                        assertedAsyncDecorator(800,
                        function(err, req, res, data) {
                            expect(err).to.be.success;
                            expect(res).to.have.status(200);
                            expect(progCounter).to.equal(4);
                            expect(lastProg).to.equal(2);
                            jobIds.push(res.jobId);
                            done();
                        },
                        function(prog) {
                            // prog is increasing every second until 5
                            expect(lastProg).to.be.most(prog);
                            lastProg = prog;
                            progCounter++;
                        }));
                }, done);
            });

            it('should read collection of async jobs', function(done) {

                // assumption: all results fit into a single page
                jsonClient.get('/jobStatus?fields=jobId,done',
                        function(err, req, res, data) {
                    expect(res).to.have.status(200);

                    var foundJobs = [];
                    for (var i in data.data) {
                        var ent = data.data[i];
                        expect(Object.keys(ent)).to.have.length(3); // + href
                        if (jobIds.indexOf(ent.jobId) !== -1) {
                            foundJobs.push(ent);
                        }
                    }
                    expect(foundJobs).to.have.length(3);
                    done();
                });
            });

            it('error returned from async method immediately', function(done) {

                jsonClient.post('/test/deferredAsync?delay=3&error=true', {},
                    function(err, req, res, data) {
                        expect(res).to.have.status(500);
                        done();
                    });
            });

            it('deferred async POST', function(done) {
                var progCounter = 0;
                var lastProg = -1;

                aux.longJob('long async operation', function(done) {
                    jsonClient.post('/test/deferredAsync?delay=3', {},
                        assertedAsyncDecorator(800,
                                function(err, req, res, data) {
                            expect(res).to.have.status(201);
                            expect(progCounter).to.equal(4);
                            expect(lastProg).to.equal(2);
                            jobIds.push(res.jobId);
                            done();
                        },
                        function(prog) {
                            // prog is increasing every second until 5
                            expect(lastProg).to.be.most(prog);
                            lastProg = prog;
                            progCounter++;
                        }));
                }, done);
            });
        });

        describe('proxy urls', function() {

            before(function(done) {
                async.series([
                    function(next) {
                        clearPeople(next);
                    },
                    function(next) {
                        jsonClient.post('/test/people', {
                            idCardNumber: 1,
                            name: 'Jack',
                            age: 33
                        }, next);
                    }
                ], done);
            });

            after(clearPeople);

            it('should correctly process a proxy request', function(done) {
                jsonClient.get(
                        '/test/people/1/proxy/a/b/c?a=1&b=2&rawQuery=par1=val1',
                        function(err, req, res, data) {
                    expect(res).to.have.status(200);
                    expect(data.data.params).to.be.deep.equal({
                        'parent': 1,
                        'proxyPath': 'a/b/c'
                    });
                    expect(data.data.query).to.be.deep.equal({
                        a: '1',
                        b: '2',
                        rawQuery: 'par1=val1'
                    });
                    done();
                });
            });
        });

        describe('HTML escaping', function() {
            const xssString = '<script>';
            const escapedString = '&lt;script&gt;';

            before(function(done) {
                async.series([
                    function(next) {
                        clearPeople(next);
                    },
                    function(next) {
                        jsonClient.post('/test/people', {
                            idCardNumber: 1,
                            name: xssString,
                            age: 33
                        }, next);
                    }
                ], done);
            });

            describe('should escape if X-XSS-PROTECTION header equal to 0',
                function() {
                    it('request with status 200', function(done) {
                        const options = {
                            path: '/test/people/1',
                            headers: {
                                'X-XSS-PROTECTION': '0'
                            }
                        };
                        jsonClient.get(options, (err, req, res, data) => {
                            expect(res).to.have.status(200);
                            expect(data.name).to.equal(escapedString);
                            done();
                        });
                    });

                    it('on 400 error', function(done) {
                        const options = {
                            path: '/test/people/???',
                            headers: {
                                'X-XSS-PROTECTION': '0'
                            }
                        };
                        jsonClient.get(options, (err, req, res, data) => {
                            expect(res).to.have.status(400);
                            expect(err.message).to
                                .equal('Path parameter &quot;idCardNumber' +
                                    '&quot; is missing');
                            done();
                        });
                    });

                    it('path in NotFound error', function(done) {
                        const options = {
                            path: '/' + xssString,
                            headers: {
                                'X-XSS-PROTECTION': '0'
                            }
                        };
                        jsonClient.get(options, (err, req, res) => {
                            expect(res).to.have.status(404);
                            expect(err.message).to.equal('/' +
                                escapedString + ' does not exist');
                            done();
                        });
                    });

                    it('path in MethodNotAllowed error',
                        function(done) {
                        // so far PATCH method is not allowed
                        const options = {
                            hostname: localhost,
                            port: port,
                            agent: false,  // prevent keep-alive
                            method: 'PATCH',
                            path: '/test/people/' + xssString,
                            headers: {
                                'X-XSS-PROTECTION': '0'
                            }
                        };
                        http.request(options, (res) => {
                            expect(res).to.have.status(405);

                            let data = '';
                            res.on('data', (chunk) => data += chunk);
                            res.on('end', () => {
                                const parsed = JSON.parse(data);
                                expect(parsed.message).to
                                    .equal('PATCH method on /test/people/' +
                                        escapedString + ' not allowed');
                                done();
                            });
                        })
                        .on('error', done)
                        .end();
                    });
                });

            describe('should not escape if X-XSS-PROTECTION header equal to 1',
                function() {
                    it('should not escape request with status 200', function(done) {
                        const options = {
                            path: '/test/people/1',
                            headers: {
                                'X-XSS-PROTECTION': '1'
                            }
                        };
                        jsonClient.get(options, (err, req, res, data) => {
                            expect(res).to.have.status(200);
                            expect(data.name).to.equal(xssString);
                            done();
                        });
                    });

                    it('should not escape on 400 error', function(done) {
                        const options = {
                            path: '/test/people/???',
                            headers: {
                                'X-XSS-PROTECTION': '1'
                            }
                        };
                        jsonClient.get(options, (err, req, res) => {
                            expect(res).to.have.status(400);
                            expect(err.message).to
                                .equal('Path parameter "idCardNumber"' +
                                    ' is missing');
                            done();
                        });
                    });

                    it('should not escape path in NotFound error',
                        function(done) {
                        const options = {
                            path: '/' + xssString,
                            headers: {
                                'X-XSS-PROTECTION': '1'
                            }
                        };
                        jsonClient.get(options, (err, req, res) => {
                            expect(res).to.have.status(404);
                            expect(err.message).to.equal('/' +
                                xssString + ' does not exist');
                            done();
                        });
                    });

                    it('should not escape path in MethodNotAllowed error',
                        function(done) {
                            // so far PATCH method is not allowed
                            const options = {
                                hostname: localhost,
                                port: port,
                                agent: false,  // prevent keep-alive
                                method: 'PATCH',
                                path: '/test/people/' + xssString,
                                headers: {
                                    'X-XSS-PROTECTION': '1'
                                }
                            };
                            http.request(options, (res) => {
                                expect(res).to.have.status(405);

                                let data = '';
                                res.on('data', (chunk) => data += chunk);
                                res.on('end', () => {
                                    const parsed = JSON.parse(data);
                                    expect(parsed.message).to
                                        .equal('PATCH method on /test/people/' +
                                            xssString + ' not allowed');
                                    done();
                                });
                            })
                            .on('error', done)
                            .end();
                        });
                });
        });
    });

    describe('/docs api documentation', function() {

        it('should disable swagger', function(done) {
            setUseSwagger(false, done);
        });

        it('should NOT show api', function(done) {
            var opts = {
                hostname: localhost,
                port: port,
                method: 'GET',
                path: '/docs',
                agent: false  // prevent keep-alive
            };

            http.get(opts, function(res) {
                expect(res).to.have.status(404);
                done();
            });
        });

        it('should enable swagger', function(done) {
            setUseSwagger(true, done);
        });

        it('should show api documentation under /docs', function(done) {
            async.series([
                function(next) {
                    var opts = {
                        hostname: localhost,
                        port: port,
                        method: 'GET',
                        path: '/docs',
                        agent: false  // prevent keep-alive
                    };

                    http.get(opts, function(res) {
                        expect(res).to.have.status(302);
                        next();
                    });
                },
                function(next) {
                    var opts = {
                        hostname: localhost,
                        port: port,
                        method: 'GET',
                        path: '/docs/index.html',
                        agent: false  // prevent keep-alive
                    };

                    http.get(opts, function(res) {
                        expect(res).to.have.status(200);
                        next();
                    });
                }
            ], done);
        });

        it('should return api-docs for swagger-ui', function(done) {
            jsonClient.get('/api-docs', function(err, req, res, data) {
                expect(res).to.have.status(200);

                var apis = data.apis.map(function(x) {
                    return x.path;
                });

                async.forEachSeries(apis, function(api, callback) {
                    jsonClient.get('/' + api, function(err, req, res, data) {
                        expect(res).to.have.status(200);
                        expect(Object.keys(data.models))
                                .to.have.length.above(0);
                        expect(data.apis).to.have.length.above(0);
                        expect(data).to.contain.keys('consumes', 'produces',
                                'swaggerVersion');
                        callback();
                    });
                }, function(err, results) {
                    if (!err) {
                        done();
                    }
                });
            });
        });
    });

    function flamegraphTests() {

        it('should generate flamegraph for procman', function(done) {
            jsonClient.post('/flamegraphs', {
                worker: 'procman',
                time: 1 // 1 second
            }, function(err, req, res, data) {
                assert.ifError(err);
                expect(res).to.have.status(303);
                expect(res).to.have.header('location', '/flamegraphs/procman');
                done();
            });
        });

        it('should get flamegraph for procman', function(done) {
            var opts = {
                hostname: localhost,
                port: port,
                method: 'GET',
                path: '/flamegraphs/procman',
                agent: false  // prevent keep-alive
            };
            var req = http.get(opts, function(res) {
                expect(res).to.have.status(200);
                // consume all data otherwise server won't close the connection
                res.on('readable', function() {
                    res.read();
                });
                done();
            });
        });
    }

    if (process.platform !== 'sunos') {
        describe.skip('/flamegraphs', flamegraphTests);
    } else {
        describe('/flamegraphs', flamegraphTests);
    }

    describe('management address', function() {
        var ipv4Client;
        var ipv6Client;
        var port = restConfig.serverPort;

        if (nefUtils.isDocker()) {
            this.pending = true;
        }

        before(function(done) {
            var ipv6Addr = restTestHelpers.getExternalAddr({
                family: 'ipv6',
                skipLocalLink: process.platform == 'linux'
            });

            ipv4Client = restTestHelpers.createRestClient({
                url: 'http://' + restTestHelpers.getExternalAddr() +
                     ':' + port,
                retry: false
            });
            ipv6Client = restTestHelpers.createRestClient({
                url: 'http://[' +  ipv6Addr + ']:' + port,
                retry: false
            });
            done();
        });

        /*
         * If mgmt address is changed to "::" the REST server is still able to
         * accept connections to the same port on IPv4, because of the dual
         * network stack implementation in nodejs. However in case this behavior
         * will change in future, we still verify that IPv4 is working after
         * reverting mgmt address back to the default.
         */
        after(function(done) {
            jsonClient.close();
            ipv4Client.close();
            ipv6Client.close();

            interop.call('sysconfig', 'setProperty', {
                id: 'nef.managementAddress',
                value: null
            }, function(err) {
                if (err) {
                    return done(err);
                }
                // wait for the change to happen
                aux.wait(30000, function(cb) {
                    ipv4Client.get('/', function(err, req, res, obj) {
                        var terminate = true;

                        if (err) {
                            if (err.code === 'ECONNREFUSED') {
                                err = null;
                                terminate = false;
                            } else if (res && res.statusCode == 401) {
                                err = null;
                            } else {
                                err = new Error('Unexpected error: ' +
                                        err.toString());
                            }
                        }
                        cb(err, terminate);
                    });
                }, done);
            });
        });

        it('should change management address to "::"', function(done) {
            async.series([
                function(next) {
                    // verify IPv6 is not accessible by default
                    ipv6Client.get('/', function(err, req, res, obj) {
                        expect(err).to.have.property('code', 'ECONNREFUSED');
                        next();
                    });
                },
                function(next) {
                    // close all clients so that the server can be restarted
                    jsonClient.close();
                    ipv4Client.close();
                    ipv6Client.close();

                    interop.call('sysconfig', 'setProperty', {
                        id: 'nef.managementAddress',
                        value: '::'
                    }, next);
                },
                function(next) {
                    // wait for the change to happen
                    aux.wait(30000, function(cb) {
                        ipv6Client.get('/', function(err, req, res, obj) {
                            var terminate = true;

                            if (err) {
                                if (err.code === 'ECONNREFUSED') {
                                    err = null;
                                    terminate = false;
                                } else if (res && res.statusCode == 401) {
                                    err = null;
                                } else {
                                    err = new Error('Unexpected error: ' +
                                            err.toString());
                                }
                            }
                            cb(err, terminate);
                        });
                    }, next);
                }
            ], done);
        });
    });

    describe('rest management address', function() {
        var client;
        var addr1 = restTestHelpers.getExternalAddr();
        var addr2 = restTestHelpers.getSecondExternalAddr();
        var port = restConfig.serverPort;

        if (nefUtils.isDocker()) {
            this.pending = true;
        }

        before('set management address', function(done) {
            interop.call('sysconfig', 'setProperty', {
                id: 'nef.managementAddress',
                value: addr1
            }, done);
        });

        after(function(done) {
            interop.call('sysconfig', 'setProperty', {
                id: 'nef.managementAddress',
                value: null
            }, done);
        });

        afterEach(function(done) {
            if (client) {
                client.close();
            }
            done();
        });

        it('should set rest management address', function(done) {
            if (!addr2) {
                this.skip();
            }
            async.series([
                function(next) {
                    setManagementAddress([addr2], next);
                },
                function(next) {
                    client = restTestHelpers.createRestClient({
                        url: 'http://' + addr2 + ':' + port,
                        retry: false
                    });
                    next();
                },
                function(next) {
                    checkAccess(client, 401, next);
                },
            ], done);
        });

        it('should clear rest management address', function(done) {
            if (!addr2) {
                this.skip();
            };
            async.series([
                function(next) {
                    setManagementAddress([], next);
                },
                function(next) {
                    client = restTestHelpers.createRestClient({
                        url: 'http://' + addr1 + ':' + port,
                        retry: false
                    });
                    next();
                },
                function(next) {
                    checkAccess(client, 401, next);
                },
            ], done);
        });

        it('should fail to set unavailable address', function(done) {
            setManagementAddress(['253.253.253.253'], function(err) {
                expect(err).to.be.defined;
                expect(err).to.have.property('code', 'EBADARG');
                done();
            });
        });
    });

    describe('versions', function() {
        var workerDir = process.env.NEF_CORE_ROOT + '/workers/rest/';
        var ApiVersion = require(workerDir + '/restVersion').ApiVersion;
        var currentVersion;

        before(function(done) {
            noverClient = restify.createJSONClient({
                url: url,
                rejectUnauthorized: false
            });
            done();
        });

        function expectSuccess(done) {
            return function(err, req, res, data) {
                assert.ifError(err);
                expect(res).to.have.status(200);
                done();
            };
        }

        function expectError(code, done) {
            return function(err, req, res, data) {
                expect(err).to.exist;
                expect(data.name).to.equal('NefError');
                expect(data.code).to.equal(code);
                done();
            };
        }

        before('request current version', function(done) {
            interop.call('rest', 'getStatus', {}, function(err, res) {
                if (err) {
                    return done(err);
                }
                currentVersion = new ApiVersion(res.apiVersion);
                done();
            });
        });

        it('should allow request with current version', function(done) {
            noverClient.get('/v' + currentVersion + '/test/people',
                            expectSuccess(done));
        });

        it('should allow request with minor-old version', function(done) {
            var tmpVer = new ApiVersion(currentVersion);
            tmpVer.minor = 0;
            noverClient.get('/v' + tmpVer + '/test/people',
                            expectSuccess(done));
        });

        it('should deny request with unknown version', function(done) {
            noverClient.get('/v999.0/test/people',
                            expectError('ENOENT', done));
        });

        it('should deny with asterisk', function(done) {
            noverClient.get('/v*/test/people',
                            expectError('ENOENT', done));
        });

        it('should deny with incomplete version', function(done) {
            noverClient.get('/v1/test/people',
                            expectError('EBADARG', done));
        });

        it('should deny with wrong major version', function(done) {
            var tmpVer = new ApiVersion(currentVersion);
            tmpVer.major -= 1;
            noverClient.get('/v' + tmpVer + '/test/people',
                            expectError('ENOENT', done));
        });

        it('should not concider people with names like "v1" as version',
            function(done) {
            noverClient.get('/test/people/v1/test',
                            expectError('ENOENT', done));
        });
    });

    describe('CORS', function() {
        function resetCors(done) {
            interop.call('sysconfig', 'setProperty', {
                id: 'worker.rest.allowOrigin',
                value: 'none'
            }, done);
        }

        before('reset CORS', resetCors);
        after('reset CORS', resetCors);

        before('enable /docs', function(done) {
            setUseSwagger(true, done);
        });

        after('disable /docs', function(done) {
            setUseSwagger(false, done);
        });

        it('should not return any allowed origin', function(done) {
            jsonClient.get('/docs/', (err, req, res, obj) => {
                assert.ifError(err);
                expect(res.headers)
                    .to.not.have.property('access-control-allow-origin');
                done();
            });
        });

        it('should allow all origins', function(done) {
            interop.call('sysconfig', 'setProperty', {
                id: 'worker.rest.allowOrigin',
                value: '*'
            }, done);
        });

        it('should return "*" in allowed origin', function(done) {
            jsonClient.get('/docs/', (err, req, res, obj) => {
                assert.ifError(err);
                expect(res.headers)
                    .to.have.property('access-control-allow-origin', '*');
                done();
            });
        });

        it('should allow specified origin', function(done) {
            interop.call('sysconfig', 'setProperty', {
                id: 'worker.rest.allowOrigin',
                value: 'http://example.com'
            }, done);
        });

        it('should return "example.com" in allowed origin', function(done) {
            jsonClient.get('/docs/', (err, req, res, obj) => {
                assert.ifError(err);
                expect(res.headers)
                    .to.have.property('access-control-allow-origin',
                                      'http://example.com');
                done();
            });
        });
    });

    describe('HTTPS protocol', function() {
        var addr = '0.0.0.0:8443';
        before('reset protocol', function(done) {
            setHttpsProtocol('TLS1.2', done);
        });

        after('reset protocol', function(done) {
            setHttpsProtocol('TLS1.2', done);
        });

        before('get https address', function(done) {
            interop.call('rest', 'getStatus', {}, (err, res) => {
                assert.ifError(err);
                var servInstance = res.instances['server'];
                assert(servInstance);
                assert.equal(servInstance.https, true);

                addr = `${servInstance.address}:${servInstance.port}`;
                done();
            });
        });

        it('should NOT be able to connect with tls1.0', function(done) {
            aux.exec('echo | openssl s_client -tls1 -connect ' + addr, false,
                (err, stdout) => {
                    assert(err, 'Error object is missing');
                    var errMsg = 'Secure Renegotiation IS NOT supported';
                    assert(stdout.toString().indexOf(errMsg) > -1,
                              'Needed error message not found');
                    done();
                });
        });

        it('should be able to connect with tls1.2', function(done) {
            aux.exec('echo | openssl s_client -tls1_2 -connect ' + addr, false,
                (err, stdout) => {
                    assert.ifError(err);
                    done();
                });
        });

        it('should enable TLS1.0 version', function(done) {
            setHttpsProtocol('TLS1.x', done);
        });

        it('should be able to connect with tls1.0', function(done) {
            aux.exec('echo | openssl s_client -tls1 -connect ' + addr, false,
                (err, stdout) => {
                    assert.ifError(err);
                    done();
                });
        });

        it('should be able to connect with tls1.2', function(done) {
            aux.exec('echo | openssl s_client -tls1_2 -connect ' + addr, false,
                (err, stdout) => {
                    assert.ifError(err);
                    done();
                });
        });

    });

});
