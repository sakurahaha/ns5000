#!/usr/bin/node

/*
 * NEF broker process
 *
 * Copyright (C) 2012-2018 Nexenta Systems, Inc
 * All rights reserved.
 *
 */

var async = require('async');
var path = require('path');
var EventMachine = require('nef/EventMachine');

var procmanUtils = require('../procmanUtils');
var broker = require('./broker');

function start() {
    var pidFile = path.join(process.env.NEF_VAR, 'broker.pid');
    process.title = 'nef:broker';

    async.series([
        next => {
            procmanUtils.updatePidFile(pidFile, {
                processType: 'broker',
                killCurrent: true
            }, next);
        },
        next => {
            process.on('exit', (code) => {
                procmanUtils.removePidFileSync(pidFile);
            });
            next();
        },
        next => broker.init(next),
        next => EventMachine.start(next),
    ], (err) => {
        if (err) {
            console.error('Failed to init broker: %s', err.toString());
        } else {
            console.log('BROKER READY');
        }

    });
}

process.on('uncaughtException', (exception) => {
    // workaround for  https://github.com/nodejs/node/issues/2762
    // rethrow SyntaxError so node will print it
    // itself, and will also add hidden 'arrow' info about
    // location where syntax error happened
    if (exception instanceof SyntaxError) {
        throw(exception);
    }
    console.log(exception.toString({verbose: true}));
    console.log(exception.stack);
    process.exit(1);
});

process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(137));
process.on('SIGHUP', () => process.exit(129));

start();
