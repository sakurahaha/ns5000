var assert = require('assert');
var Client = require('nef/client');
var util = require('util');
var nefUtils = require('nef/utils');
var testHelpers = require('nef/testHelpers');

module.exports = function test() {
    var self = this;

    describe('array operations', function() {
        it('should set initial value', function(done) {
            self.worker.setProperty({
                'id': 'test.aList',
                'value': ['one', 'two', 'three']
            }, function(err, res) {
                assert.ifError(err);
                done();
            });
        });

        it('should insert new value into the array', function(done) {
            self.worker.insertIntoProperty({
                'id': 'test.aList',
                'index': 2,
                'value': 'hello',
            }, function(err, res) {
                assert.ifError(err);
                done();
            });
        });

        it('should have hello in new value', function(done) {
            self.worker.getProperty({
                'id': 'test.aList',
            }, function(err, res) {
                assert.ifError(err);
                assert.deepEqual(res, ['one', 'two', 'hello', 'three']);
                done();
            });
        });

        it('should replace by index in the array', function(done) {
            self.worker.replaceInProperty({
                'id': 'test.aList',
                'index': 0,
                'value': 'uno',
            }, function(err, res) {
                assert.ifError(err);
                done();
            });
        });

        it('should have new name for first element', function(done) {
            self.worker.getProperty({
                'id': 'test.aList',
            }, function(err, res) {
                assert.ifError(err);
                assert.deepEqual(res, ['uno', 'two', 'hello', 'three']);
                done();
            });
        });

        it('should delete from the array', function(done) {
            self.worker.deleteFromProperty({
                'id': 'test.aList',
                'index': 1,
            }, function(err, res) {
                assert.ifError(err);
                done();
            });
        });

        it('should not have two in current value', function(done) {
            self.worker.getProperty({
                'id': 'test.aList',
            }, function(err, res) {
                assert.ifError(err);
                assert.deepEqual(res, ['uno', 'hello', 'three']);
                done();
            });
        });
    });

    describe('object operations', function() {
        it('should set initial value', function(done) {
            self.worker.setProperty({
                'id': 'test.anObject',
                'value': {
                    'name': 'Bob',
                    'birthDay': '2000-01-01'
                },
            }, function(err, res) {
                assert.ifError(err);
                done();
            });
        });

        it('should insert new key-value the object', function(done) {
            self.worker.insertIntoProperty({
                'id': 'test.anObject',
                'key': 'secondName',
                'value': 'Hoskins',
            }, function(err, res) {
                assert.ifError(err);
                done();
            });
        });

        it('should have secondName in new value', function(done) {
            self.worker.getProperty({
                'id': 'test.anObject',
            }, function(err, res) {
                assert.ifError(err);
                assert.deepEqual(res, {
                    'name': 'Bob',
                    'birthDay': '2000-01-01',
                    'secondName': 'Hoskins',
                });
                done();
            });
        });

        it('should replace by key in the object', function(done) {
            self.worker.replaceInProperty({
                'id': 'test.anObject',
                'key': 'birthDay',
                'value': '1947-10-12',
            }, function(err, res) {
                assert.ifError(err);
                done();
            });
        });

        it('should have new birthDay in current value', function(done) {
            self.worker.getProperty({
                'id': 'test.anObject',
            }, function(err, res) {
                assert.ifError(err);
                assert.deepEqual(res, {
                    'name': 'Bob',
                    'birthDay': '1947-10-12',
                    'secondName': 'Hoskins',
                });
                done();
            });
        });

        it('should delete by key from the object', function(done) {
            self.worker.deleteFromProperty({
                'id': 'test.anObject',
                'key': 'birthDay',
            }, function(err, res) {
                assert.ifError(err);
                done();
            });
        });

        it('should not have birthDay in current value', function(done) {
            self.worker.getProperty({
                'id': 'test.anObject',
            }, function(err, res) {
                assert.ifError(err);
                assert.deepEqual(res, {
                    'name': 'Bob',
                    'secondName': 'Hoskins',
                });
                done();
            });
        });
    });

    describe('array of objects operations', function() {
        it('should set initial value', function(done) {
            self.worker.setProperty({
                id: 'test.aList',
                value: [
                    {
                        id: '1st',
                        color: 'Green'
                    },
                    {
                        id: '2nd',
                        color: 'Pink'
                    }
                ]
            }, done);
        });

        it('should give error when index is used together with key+keyName',
                function(done) {
            self.worker.insertIntoProperty({
                id: 'test.aList',
                key: '2nd',
                keyName: 'id',
                index: 1,
                value: {
                    id: '1.5',
                    color: 'Brown'
                }
            }, function(err, res) {
                assert.errorIs('EBADARG', err);
                done();
            });
        });

        it('should insert new value into the array', function(done) {
            self.worker.insertIntoProperty({
                id: 'test.aList',
                key: '2nd',
                keyName: 'id',
                value: {
                    id: '1.5',
                    color: 'Brown'
                }
            }, done);
        });

        it('should push value to the end of array', function(done) {
            self.worker.insertIntoProperty({
                id: 'test.aList',
                index: -1,
                value: {
                    id: 'last',
                    color: 'Yellow'
                }
            }, done);
        });

        it('should give error when entry with key already exists',
                function(done) {
            self.worker.insertIntoProperty({
                id: 'test.aList',
                keyName: 'id',
                index: -1,
                value: {
                    id: '1st',
                    color: 'Yellow'
                }
            }, function(err, res) {
                assert.errorIs('EEXIST', err);
                done();
            });
        });

        it('should check inserted values', function(done) {
            self.worker.getProperty({
                'id': 'test.aList',
            }, function(err, res) {
                assert.ifError(err);
                var ids = nefUtils.pluck(res, 'id');
                assert.deepEqual(ids, ['1st', '1.5', '2nd', 'last']);
                done();
            });
        });

        it('should replace by index in the array', function(done) {
            self.worker.replaceInProperty({
                id: 'test.aList',
                key: '2nd',
                keyName: 'id',
                value: {
                    id: '2nd.v2',
                    color: 'Pink.v2'
                },
            }, done);
        });

        it('should check replaced value', function(done) {
            self.worker.getProperty({
                'id': 'test.aList',
            }, function(err, res) {
                assert.ifError(err);
                var ids = nefUtils.pluck(res, 'id');
                assert.deepEqual(ids, ['1st', '1.5', '2nd.v2', 'last']);
                done();
            });
        });

        it('should replace by key in the array', function(done) {
            self.worker.replaceInProperty({
                id: 'test.aList',
                key: '2nd.v2',
                keyName: 'id',
                value: {
                    id: '2nd.v3',
                    color: 'Pink.v3'
                },
            }, done);
        });

        it('should insert if not exists in the array', function(done) {
            self.worker.replaceInProperty({
                id: 'test.aList',
                key: 'last2',
                keyName: 'id',
                insertIfNotExists: true,
                value: {
                    id: 'last2',
                    color: 'Carmine'
                },
            }, done);
        });

        it('should not insert if not exists in the array', function(done) {
            self.worker.replaceInProperty({
                id: 'test.aList',
                key: 'last3',
                keyName: 'id',
                value: {
                    id: 'last3',
                    color: 'Crimson'
                },
            }, function(err, res) {
                assert.ifError(!err);
                done();
            });
        });

        it('should check replaced value', function(done) {
            self.worker.getProperty({
                'id': 'test.aList',
            }, function(err, res) {
                assert.ifError(err);
                var ids = nefUtils.pluck(res, 'id');

                assert.deepEqual(ids, ['1st', '1.5', '2nd.v3', 'last',
                    'last2']);

                done();
            });
        });

        it('should delete from the array', function(done) {
            self.worker.deleteFromProperty({
                id: 'test.aList',
                key: '1st',
                keyName: 'id',
            }, done);
        });

        it('should not have two in current value', function(done) {
            self.worker.getProperty({
                'id': 'test.aList',
            }, function(err, res) {
                assert.ifError(err);
                var ids = nefUtils.pluck(res, 'id');
                assert.deepEqual(ids, ['1.5', '2nd.v3', 'last', 'last2']);
                done();
            });
        });
    });

    describe('scalar operations', function() {
        it('should fail on insert for scalar', function(done) {
            self.worker.insertIntoProperty({
                'id': 'test.aValue',
                'index': 99,
                'value': 434
            }, function(err, res) {
                assert.ifError(!err);
                done();
            });
        });

        it('should fail on replace for scalar', function(done) {
            self.worker.replaceInProperty({
                'id': 'test.aValue',
                'index': 99,
                'value': 434
            }, function(err, res) {
                assert.ifError(!err);
                done();
            });
        });

        it('should fail on delete from scalar', function(done) {
            self.worker.deleteFromProperty({
                'id': 'test.aValue',
                'index': 99,
            }, function(err, res) {
                assert.ifError(!err);
                done();
            });
        });
    });

    // TODO
    describe('events for subelement modifications', () => {
        beforeEach((done) => {
            self.worker.bulkSetProperties({
                pairs: {
                    'test.aList': [5, 5, 5]
                }
            }, done);
        });

        it('should emit event for insertIntoProperty', (done) => {
            testHelpers.waitEvent({
                event: 'NEF_sysconfig_set_param',
                done: done,
                prepare(cb) {
                    self.worker.insertIntoProperty({
                        id: 'test.aList',
                        value: 7,
                        index: -1,
                        context: 'Test run'
                    }, cb);
                },
                filter(evt) {
                    return evt.id == 'test.aList' &&
                           evt.context.type !== 'bulkSet';
                },
                process(evt, cb) {
                    assert.equal(evt.context.name, 'Test run');
                    assert.equal(evt.context.type, 'set');
                    assert.deepEqual(evt.value, [5, 5, 5, 7]);
                    cb();
                }
            });
        });

        it('should emit event for replaceInProperty', (done) => {
            testHelpers.waitEvent({
                event: 'NEF_sysconfig_set_param',
                done: done,
                prepare(cb) {
                    self.worker.replaceInProperty({
                        id: 'test.aList',
                        value: 7,
                        index: 0,
                        context: 'Test run'
                    }, cb);
                },
                filter(evt) {
                    return evt.id == 'test.aList' &&
                           evt.context.type !== 'bulkSet';
                },
                process(evt, cb) {
                    assert.equal(evt.context.name, 'Test run');
                    assert.equal(evt.context.type, 'set');
                    assert.deepEqual(evt.value, [7, 5, 5]);
                    cb();
                }
            });
        });

        it('property which is both volatile and cluster-wide should also ' +
            'provide the new value in the event', (done) => {
            var newVal = process.pid;

            testHelpers.waitEvent({
                event: 'NEF_sysconfig_set_param',
                done: done,
                prepare(cb) {
                    self.worker.setProperty({
                        'id': 'test.volatileHaThing',
                        'value': newVal,
                        'context': 'Test run'
                    }, cb);
                },
                filter(evt) {
                    return evt.id == 'test.volatileHaThing' &&
                        evt.context.type !== 'bulkSet';
                },
                process(evt, cb) {
                    assert.equal(evt.context.name, 'Test run');
                    assert.equal(evt.context.type, 'set');
                    assert.deepEqual(evt.value, newVal);
                    cb();
                }
            });
        });

        it('should emit event for deleteFromProperty', (done) => {
            testHelpers.waitEvent({
                event: 'NEF_sysconfig_set_param',
                done: done,
                prepare(cb) {
                    self.worker.deleteFromProperty({
                        id: 'test.aList',
                        index: 0,
                        context: 'Test run'
                    }, cb);
                },
                filter(evt) {
                    return evt.id == 'test.aList' &&
                           evt.context.type !== 'bulkSet';
                },
                process(evt, cb) {
                    assert.equal(evt.context.name, 'Test run');
                    assert.equal(evt.context.type, 'set');
                    assert.deepEqual(evt.value, [5, 5]);
                    cb();
                }
            });
        });
    });
};
