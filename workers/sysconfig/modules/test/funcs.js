var fs = require('fs');
var logger = require('nef/logger');
var NefError = require('nef/error').NefError;
var nefUtils = require('nef/utils');

var file = '/tmp/nef-test-module.file';
var current = undefined;
var cache = {};

module.exports.setFile = function(newfile) {
    file = newfile;
};

module.exports.getStored = function(callback) {
    callback(undefined, current);
};

module.exports.setStored = function(value, callback) {
    current = value;
    callback();
};

module.exports.getStoredPersistently = function(callback) {
    fs.readFile(file, 'utf-8', function(err, data) {
        callback(undefined, err ? '' : data);
    });
};

module.exports.setStoredPersistently = function(value, callback) {
    fs.writeFile(file, value, function(err) {
        if (err) {
            return callback(NefError('EIO',
                __('Unable to save file: %s', file)));
        }
        callback();
    });
};

module.exports.rebootTest = function(ctx, value, callback) {
    if (value === 'reboot') {
        callback(undefined, {rebootNeeded: true});
    } else {
        callback();
    }
};

module.exports.fakeGet = function(prop, ctx, callback) {
    callback(undefined, cache[prop.id] || 'undefined');
};

module.exports.fakeSet = function(prop, ctx, value, callback) {
    cache[prop.id] = value;
    callback();
};

module.exports.constantGetter = function(constant) {
    return (cb) => {
        cb(undefined, constant);
    };
};

module.exports.rollbackTestSetter = function(prop, ctx, value, done) {
    prop.module.getProperty('rollbackMeter').tValue = {};
    ctx.currentCalled = true;

    if (value === 'fail current') {
        done(NefError('EBADARG', __('Failure in current setter')));
    } else {
        done();
    }
};

module.exports.rollbackTestPersistentSetter = function(prop, ctx, value, done) {
    prop.module.getProperty('rollbackMeter').tValue = {};
    ctx.persistentCalled = true;

    if (value === 'fail persistent') {
        done(NefError('EBADARG', __('Failure in persistent setter')));
    } else {
        done();
    }
};

module.exports.rollbackTestRollback = function(prop, ctx, err, done) {
    prop.module.getProperty('rollbackMeter').tValue = {
        called: true,
        err: err.toString(),
        ctx: ctx.dump()
    };
    done();
};

