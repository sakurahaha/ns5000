var assert = require('assert');
var Client = require('nef/client');
var util = require('util');
var nefUtils = require('nef/utils');
var testHelpers = require('nef/testHelpers');

module.exports = function test() {
    var self = this;

    describe('enumerators', function() {
        it('should return list of modules', function(done) {
            self.worker.findModules({}, function(err, modules) {
                assert.ifError(err);
                assert(util.isArray(modules));
                assert(modules.length > 0);
                done();
            });
        });

        it('should return list of properties in "test" module', function(done) {
            self.worker.findProperties({
                where: {
                    module: 'test'
                }
            }, function(err, props) {
                assert.ifError(err);
                assert(util.isArray(props));
                assert(props.length > 0);

                done();
            });
        });

        it('should list all properties with find method', function(done) {
            self.worker.findProperties({
            }, function(err, val) {
                assert.ifError(err);
                assert(Object.keys(val).length > 10);
                done();
            });
        });

        it('should find parameters by id', function(done) {
            self.worker.findProperties({
                where: {
                    id: 'test.aValue',
                }
            }, function(err, props) {
                assert.ifError(err);
                assert.equal(props.length, 1);
                assert.equal(props[0].name, 'aValue');
                done();
            });
        });

        it('should find parameters with values, if asked', function(done) {
            self.worker.findProperties({
                where: {
                    id: 'test.aValue',
                },
                includeValues: true,
            }, function(err, props) {
                assert.ifError(err);
                assert.equal(props.length, 1);
                assert.equal(props[0].name, 'aValue');
                assert.equal(typeof props[0].currentValue, 'number');
                assert.equal(typeof props[0].storedValue, 'number');
                done();
            });
        });

        it('should return meta info for value', function(done) {
            self.worker.findProperties({
                where: {
                    module: 'test'
                }
            }, function(err, props) {
                assert.ifError(err);

                var dict = nefUtils.arrayToDict(props, 'id');

                // check for haSync
                assert.equal(dict['test.aValue'].haSync, true);
                assert.equal(dict['test.aList'].haSync, undefined);

                // check for version
                assert.equal(typeof(dict['test.aValue'].version), 'number');

                // check for updatedAt
                assert.equal(typeof(dict['test.aValue'].updatedAt), 'string');
                done();
            });
        });

    });

    describe('getters', function() {
        it('should return current value by prop\'s id', function(done) {
            self.worker.getProperty({
                id: 'test.aValue',
            }, function(err, val) {
                assert.ifError(err);
                assert(val);
                done();
            });
        });

        it('should return value by module + name', function(done) {
            self.worker.getProperty({
                module: 'test',
                name: 'aValue'
            }, function(err, val) {
                assert.ifError(err);
                assert(val);
                done();
            });
        });

        it('should not return parameter from "invalid" module', function(done) {
            self.worker.getProperty({
                module: 'invalid',
                name: 'hostName'
            }, function(err, val) {
                assert.equal(Client.errCode(err), 'ENOENT');
                done();
            });
        });

        it('should not return invalid parameter from invalid name',
            function(done) {

                self.worker.getProperty({
                    module: 'test',
                    name: 'invalid'
                }, function(err, val) {
                    assert.equal(Client.errCode(err), 'ENOENT');
                    done();
                });
            });
    });

    describe('setters', function() {
        var curValue;

        it('should get current value for aValue', function(done) {
            self.worker.getProperty({
                id: 'test.aValue',
            }, function(err, val) {
                assert.ifError(err);
                assert(val);
                curValue = val;
                done();
            });
        });

        it('should increase aValue using id to address it', function(done) {
            self.worker.setProperty({
                id: 'test.aValue',
                value: curValue + 10,
            }, function(err, val) {
                assert.ifError(err);
                done();
            });
        });

        it('should ensure that aValue is changed', function(done) {
            self.worker.getProperty({
                id: 'test.aValue',
            }, function(err, val) {
                assert.ifError(err);
                assert(val);
                assert.equal(val, curValue + 10);
                done();
            });
        });

        it('should increase aValue using module+time pair', function(done) {
            self.worker.setProperty({
                module: 'test',
                name: 'aValue',
                value: curValue + 20
            }, function(err, val) {
                assert.ifError(err);
                done();
            });
        });

        it('should ensure that aValue is changed', function(done) {
            self.worker.getProperty({
                id: 'test.aValue'
            }, function(err, val) {
                assert.ifError(err);
                assert(val);
                assert.equal(val, curValue + 20);
                done();
            });
        });

        it('should increase aValue using publicName value', function(done) {
            self.worker.setProperty({
                publicName: 'test.aValue',
                value: curValue + 30
            }, function(err, val) {
                assert.ifError(err);
                done();
            });
        });

        it('should ensure that aValue is changed', function(done) {
            self.worker.getProperty({
                publicName: 'test.aValue'
            }, function(err, val) {
                assert.ifError(err);
                assert(val);
                assert.equal(val, curValue + 30);
                done();
            });
        });
    });

    describe('bulk setters', function() {
        it('should set several values at once', function(done) {
            self.worker.bulkSetProperties({
                pairs: {
                    'test.aValue': 500,
                    'test.aList': [5, 5, 5],
                    'test.anObject': {
                        tmpProp: 123
                    },
                    'test.rebootTest': 'reboot'
                }
            }, function(err, res) {
                assert.ifError(err);
                assert(res.rebootNeeded, 'rebootNeeded is true');
                done();
            });
        });

        it('should make sure that values are changed', function(done) {
            self.worker.findProperties({
                where: {module: 'test'},
                includeCurrentValues: true
            }, function(err, res) {
                assert.ifError(err);
                var cfg = nefUtils.arrayToDict(res, 'id', 'currentValue');
                assert.equal(cfg['test.aValue'], 500);
                assert.deepEqual(cfg['test.aList'], [5, 5, 5]);
                assert.deepEqual(cfg['test.anObject'], {tmpProp: 123});
                assert.equal(cfg['test.rebootTest'], 'reboot');
                done();
            });
        });
    });

    describe('readonly test', function() {
        it('should get readonly value', function(done) {
            self.worker.getProperty({
                module: 'test',
                name: 'readOnlyThing'
            }, function(err, val) {
                assert.ifError(err);
                assert.equal(val, 'constant');
                done();
            });
        });

        it('should not allow to change readonly params', function(done) {
            self.worker.setProperty({
                module: 'test',
                name: 'readOnlyThing',
                value: 'modification'
            }, function(err, val) {
                assert(err);
                assert.equal(err.code, 'EINVAL');
                done();
            });
        });
    });

    describe('reset value test', function() {
        var num = 10;

        it('should set persistent default value', function(done) {
            self.worker.setProperty({
                module: 'test',
                name: 'aValue',
                value: num,
                persistent: true,
            }, function(err) {
                assert.ifError(err);
                done();
            });
        });

        it('should set temporary value', function(done) {
            self.worker.setProperty({
                module: 'test',
                name: 'aValue',
                value: num + 5,
                persistent: false,
            }, function(err, val) {
                assert.ifError(err);
                done();
            });
        });

        it('should get new temporary value', function(done) {
            self.worker.getProperty({
                module: 'test',
                name: 'aValue',
                persistent: false,
            }, function(err, val) {
                assert.ifError(err);
                assert.equal(typeof(val), 'number');
                assert.equal(num + 5, val);
                done();
            });
        });

        it('should reset temporary value to persistent', function(done) {
            self.worker.resetProperty({
                module: 'test',
                name: 'aValue',
            }, function(err, val) {
                assert.ifError(err);
                done();
            });
        });

        it('should get temporary value == old persistent', function(done) {
            self.worker.getProperty({
                module: 'test',
                name: 'aValue',
                persistent: false,
            }, function(err, val) {
                assert.ifError(err);
                assert.equal(num, val);
                done();
            });
        });

        it('should not allow resetting volatile props', function(done) {
            self.worker.resetProperty({
                module: 'test',
                name: 'volatileThing'
            }, function(err, val) {
                assert.errorIs('EINVAL', err);
                done();
            });
        });

        it('should not allow resetting always persist props', function(done) {
            self.worker.resetProperty({
                module: 'test',
                name: 'persistentThing'
            }, function(err, val) {
                assert.errorIs('EINVAL', err);
                done();
            });
        });

        it('should not allow resetting readonly props', function(done) {
            self.worker.resetProperty({
                module: 'test',
                name: 'readOnlyThing'
            }, function(err, val) {
                assert.errorIs('EINVAL', err);
                done();
            });
        });
    });

    describe('protected propery', () => {
        before((done) => {
            self.worker.bulkSetProperties({
                pairs: {
                    'test.password': 'old pass'
                }
            }, done);
        });

        it('should set protected property', (done) => {
            self.worker.setProperty({
                id: 'test.password',
                value: 'new pass',
                persistent: true
            }, done);
        });

        it('should GET protected property without secure', (done) => {
            self.worker.getProperty({
                id: 'test.password',
            }, (err, res) => {
                assert.ifError(err);
                assert.equal(res, 'new pass');
                done();
            });
        });

        it('should GET protected property with secure as mask', (done) => {
            self.worker.getProperty({
                id: 'test.password',
                secure: true
            }, (err, res) => {
                assert.ifError(err);
                assert.notEqual(res, 'new pass');
                done();
            });
        });

        it('should FIND protected property without secure', (done) => {
            self.worker.findProperties({
                where: {
                    id: 'test.password',
                },
                includeValues: true
            }, (err, res) => {
                assert.ifError(err);
                assert.equal(res[0].currentValue, 'new pass');
                assert.equal(res[0].storedValue, 'new pass');
                done();
            });
        });

        it('should FIND protected property with secure as mask', (done) => {
            self.worker.findProperties({
                where: {
                    id: 'test.password',
                },
                includeValues: true,
                secure: true
            }, (err, res) => {
                assert.ifError(err);
                assert.notEqual(res[0].currentValue, 'new pass');
                assert.notEqual(res[0].storedValue, 'new pass');
                done();
            });
        });

        it('should EXPORT protected property without secure', (done) => {
            self.worker.exportConfiguration({
                where: {
                    id: 'test.password',
                },
            }, (err, res) => {
                assert.ifError(err);
                var conf = JSON.parse(res);
                assert.equal(conf.modules[0].properties['password'],
                             'new pass');
                done();
            });
        });

        it('should EXPORT with secure without protected property', (done) => {
            self.worker.exportConfiguration({
                where: {
                    id: 'test.password',
                },
                secure: true
            }, (err, res) => {
                assert.ifError(err);
                var conf = JSON.parse(res);
                assert.equal(conf.modules.length, 0);  // no props => no modules
                done();
            });
        });
    });

    describe('rebootTest value', function() {
        it('should not require reboot if set to wrong value', function(done) {
            self.worker.setProperty({
                id: 'test.rebootTest',
                value: 'safeValue',
            }, function(err, res) {
                assert.ifError(err);
                assert(!res.rebootNeeded, 'rebootNeeded is undefined or false');
                done();
            });
        });

        it('should require reboot if set to reboot value', function(done) {
            self.worker.setProperty({
                id: 'test.rebootTest',
                value: 'reboot',
            }, function(err, res) {
                assert.ifError(err);
                assert(res.rebootNeeded, 'rebootNeeded is true');
                done();
            });
        });
    });

    describe('includeValues functionality', function() {
        before(function(done) {
            self.worker.bulkSetProperties({
                pairs: {
                    'test.aList': [1, 2, 3],
                    'test.aValue': 123,
                },
                persistent: true,
            }, done);
        });

        it('should load current and stored values if includeValues given',
            function(done) {

                self.worker.findProperties({
                    where: {
                        module: 'test',
                        nameIn: ['aValue', 'aList']
                    },
                    includeValues: true,
                }, function(err, res) {
                    assert.ifError(err);
                    assert(res.length > 0, 'should have elements');
                    for (var i = 0; i < res.length; i++) {
                        assert(res[i].hasOwnProperty('currentValue'));
                        assert(res[i].hasOwnProperty('storedValue'));
                    }
                    done();
                });
            });

        it('should load only current values if includeCurrentValues given',
            function(done) {

                self.worker.findProperties({
                    where: {
                        module: 'test',
                        nameIn: ['aValue', 'aList']
                    },
                    includeCurrentValues: true,
                }, function(err, res) {
                    assert.ifError(err);
                    assert(res.length > 0, 'should have elements');
                    for (var i = 0; i < res.length; i++) {
                        assert(res[i].hasOwnProperty('currentValue'));
                        assert(!res[i].hasOwnProperty('storedValue'));
                    }
                    done();
                });
            });

        it('should load only stored values if includeStoredValues given',
            function(done) {

                self.worker.findProperties({
                    where: {
                        module: 'test',
                        nameIn: ['aValue', 'aList']
                    },
                    includeStoredValues: true,
                }, function(err, res) {
                    assert.ifError(err);
                    assert(res.length > 0, 'should have elements');
                    for (var i = 0; i < res.length; i++) {
                        assert(!res[i].hasOwnProperty('currentValue'));
                        assert(res[i].hasOwnProperty('storedValue'));
                    }
                    done();
                });
            });

        it('should still load and show current value when find(fields) is used',
            function(done) {

                self.worker.findProperties({
                    where: {
                        module: 'test',
                        nameIn: ['aValue', 'aList']
                    },
                    fields: ['name', 'module'],
                    includeCurrentValues: true,
                }, function(err, res) {
                    assert.ifError(err);
                    assert(res.length > 0, 'should have elements');
                    for (var i = 0; i < res.length; i++) {
                        assert(res[i].hasOwnProperty('currentValue'));
                        assert(!res[i].hasOwnProperty('storedValue'));
                    }
                    done();
                });
            });

        it('should not show current or stored, when fields are used',
            function(done) {

                self.worker.findProperties({
                    where: {
                        module: 'test',
                        nameIn: ['aValue', 'aList']
                    },
                    fields: ['name', 'module'],
                }, function(err, res) {
                    assert.ifError(err);
                    assert(res.length > 0, 'should have elements');
                    for (var i = 0; i < res.length; i++) {
                        assert(!res[i].hasOwnProperty('currentValue'));
                        assert(!res[i].hasOwnProperty('storedValue'));
                    }
                    done();
                });
            });
    });

    describe('strictness of persistent flag', function() {
        it('should NOT set temporaryOnly with strict', function(done) {
            self.worker.setProperty({
                id: 'test.temporaryThing',
                value: 'someValue',
                persistent: true,
                strict: true
            }, function(err, res) {
                assert.errorIs('EINVAL', err);
                done();
            });
        });
        it('should set temporaryOnly with strict', function(done) {
            self.worker.setProperty({
                id: 'test.temporaryThing',
                value: 'someValue',
                persistent: true,
                strict: false
            }, function(err, res) {
                assert.ifError(err);
                done();
            });
        });
        it('should NOT set persistentOnly with strict', function(done) {
            self.worker.setProperty({
                id: 'test.persistentThing',
                value: 'someValue',
                persistent: false,
                strict: true
            }, function(err, res) {
                assert.errorIs('EINVAL', err);
                done();
            });
        });
        it('should set persistentOnly with strict', function(done) {
            self.worker.setProperty({
                id: 'test.persistentThing',
                value: 'someValue',
                persistent: false,
                strict: false
            }, function(err, res) {
                assert.ifError(err);
                done();
            });
        });
    });

    describe('support of default value', function() {
        before(function(done) {
            self.worker.bulkSetProperties({
                pairs: {
                    'test.aValue': 123,
                },
                persistent: true,
            }, done);
        });

        it('should reset value to default with set(null)', function(done) {
            self.worker.setProperty({
                id: 'test.aValue',
                value: null,
                persistent: true,
            }, function(err) {
                assert.ifError(err);
                done();
            });
        });

        it('should return default value in getProperty', function(done) {
            self.worker.getProperty({
                id: 'test.aValue',
            }, function(err, res) {
                assert.ifError(err);
                assert.equal(res, 42);  // default value
                done();
            });
        });

        it('should return default value in findProperties', function(done) {
            self.worker.findProperties({
                where: {
                    id: 'test.aValue',
                },
                includeValues: true,
            }, function(err, res) {
                assert.ifError(err);
                assert.equal(res.length, 1);
                assert.equal(res[0].currentValue, 42);  // default value
                assert.equal(res[0].storedValue, 42);  // default value
                done();
            });
        });
    });

    describe('persistent storage', function() {
        var oldInfo;
        var newInfo;

        before(function(done) {
            self.worker.bulkSetProperties({
                pairs: {
                    'test.aValue': 123,
                },
                persistent: true,
            }, done);
        });

        before('remember metaInfo', function(done) {
            self.worker.findProperties({
                where: {
                    id: 'test.aValue'
                }
            }, function(err, res) {
                assert.ifError(err);
                assert.equal(res.length, 1);

                oldInfo = res[0];
                done();
            });
        });

        it('should update value temporary', function(done) {
            self.worker.setProperty({
                id: 'test.aValue',
                value: 555,
                persistent: false,
            }, done);
        });

        it('should wait for sysconfig restart', function(done) {
            testHelpers.waitWorkerRestart('sysconfig', done);
        });

        it('should check that value is old', function(done) {
            self.worker.getProperty({
                id: 'test.aValue'
            }, function(err, res) {
                assert.ifError(err);
                assert.equal(res, 123);
                done();
            });
        });

        it('should check that metaInfo is old', function(done) {
            self.worker.findProperties({
                where: {
                    id: 'test.aValue'
                }
            }, function(err, res) {
                assert.ifError(err);
                assert.equal(res.length, 1);

                var info = res[0];
                assert.equal(info.version, oldInfo.version);
                assert.equal(info.updatedAt, oldInfo.updatedAt);

                done();
            });
        });

        it('should update value persistently', function(done) {
            self.worker.setProperty({
                id: 'test.aValue',
                value: 555,
                persistent: true,
            }, done);
        });

        it('should check that metaInfo is updated', function(done) {
            self.worker.findProperties({
                where: {
                    id: 'test.aValue'
                }
            }, function(err, res) {
                assert.ifError(err);
                assert.equal(res.length, 1);

                newInfo = res[0];
                assert(newInfo.version > oldInfo.version);
                assert(newInfo.updatedAt > oldInfo.updatedAt);

                done();
            });
        });

        it('should wait for sysconfig restart', function(done) {
            testHelpers.waitWorkerRestart('sysconfig', done);
        });

        it('should check that value is new', function(done) {
            self.worker.getProperty({
                id: 'test.aValue'
            }, function(err, res) {
                assert.ifError(err);
                assert.equal(res, 555);
                done();
            });
        });

        it('should check that metaInfo is still updated', function(done) {
            self.worker.findProperties({
                where: {
                    id: 'test.aValue'
                }
            }, function(err, res) {
                assert.ifError(err);
                assert.equal(res.length, 1);

                var info = res[0];
                assert.equal(info.version, newInfo.version);
                assert.equal(info.updatedAt, newInfo.updatedAt);

                done();
            });
        });
    });

    // TODO
    describe('events for prop modification', () => {
        before((done) => {
            self.worker.bulkSetProperties({
                pairs: {
                    'test.aValue': 500,
                    'test.aList': [5, 5, 5]
                }
            }, done);
        });

        it('should emit event for setProperty', (done) => {
            testHelpers.waitEvent({
                event: 'NEF_sysconfig_set_param',
                done: done,
                prepare(cb) {
                    self.worker.setProperty({
                        id: 'test.aValue',
                        value: 600,
                        context: 'Test run'
                    }, cb);
                },
                filter(evt) {
                    return evt.id == 'test.aValue';
                },
                process(evt, cb) {
                    assert.equal(evt.context.name, 'Test run');
                    assert.equal(evt.context.type, 'set');
                    cb();
                }
            });
        });

        it('should emit event for bulkSetProperty', (done) => {
            var want = {
                'test.aValue': undefined,
                'test.aList': undefined

            };
            testHelpers.waitEvent({
                event: 'NEF_sysconfig_set_param',
                done: done,
                prepare(cb) {
                    self.worker.bulkSetProperties({
                        pairs: {
                            'test.aValue': 700,
                            'test.aList': [7, 7, 7]
                        },
                        context: 'Test run'
                    }, cb);
                },
                filter(evt) {
                    if (evt.id in want) {
                        want[evt.id] = evt;
                    }

                    return want['test.aValue'] && want['test.aList'];
                },
                process(evt, cb) {
                    for (id in want) {
                        assert(want[id]);
                        assert.equal(want[id].context.name, 'Test run');
                        assert.equal(want[id].context.type, 'bulkSet');

                    }
                    cb();
                }
            });
        });
    });

};
