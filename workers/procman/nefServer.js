#!/usr/bin/node

/*
 * NS API server procman process
 *
 * Copyright (C) 2012-2017 Nexenta Systems, Inc
 * All rights reserved.
 *
 */

'use strict'

var async = require('async');
var optimist = require('optimist');
var fse = require('fs-extra');
var fs = require('fs');
var path = require('path');

var logger = require('nef/logger');
var nefUtils = require('nef/utils');
var procmanUtils = require('./procmanUtils');
var procman = require('./procmanWorker').procman;

var config = nefUtils.requireConfig('config/common');

function checkCmdOpts(argv) {
    if (argv.h) {
        return false;
    }

    if (argv.j && typeof(argv.j) === 'string') {
        argv.j = [argv.j];
        argv.just = argv.j;
    }

    if (argv.J && typeof(argv.J) === 'string') {
        argv.J = [argv.J];
        argv['truly-just'] = argv.J;
    }

    if (argv.s && typeof(argv.s) === 'string') {
        argv.s = [argv.s];
        argv.skip = argv.s;
    }

    return true;
}

////////////////// main ///////////////////////

var argv = optimist.usage('Nexenta Elastic Framework Server', {
    'h': {
        description: 'Show this help',
        alias: 'help'
    },
    'j': {
        description: 'Run just this worker and workers it depends on',
        alias: 'just'
    },
    'J': {
        description: 'Run just this worker',
        alias: 'truly-just'
    },
    'r': {
        description: 'Reset DB state and load configuration from config file',
        alias: 'reset'
    },
    's': {
        description: 'Skip worker',
        alias: 'skip'
    },
    'c': {
        description: 'Force color output',
        alias: 'colors'
    }
}).argv;

if (!checkCmdOpts(argv)) {
    optimist.showHelp();
    process.exit(1);
}

function start() {
    var pidFile = path.join(process.env.NEF_VAR, 'nef.pid');
    process.title = 'nef:procman';
    process.env.NEF_PROCESS_TYPE = 'procman';

    async.series([
        (next) => {
            fse.ensureDir(process.env.NEF_VAR, 0o700, next);
        },
        // update pid file
        (next) => {
            procmanUtils.updatePidFile(pidFile, {
                processType: 'procman'
            }, next);
        },
        next => {
            process.on('exit', (code) => {
                procmanUtils.removePidFileSync(pidFile);
            });
            next();
        },
        // update hostId
        (next) => {
            procmanUtils.updateHostIdFile(next);
        },
        // process manager
        (next) => {
            procman.init({
                resetDb: !!argv.r,
                skipWorkers: argv.s,
                startWorkers: argv.j,
                startWorkersOnly: argv.J,
                colors: argv.c,
            }, next);
        },
        (next) => {
            procman.start(next);
        }
    ], function(err) {
        if (err) {
            logger.error(__('Procman is unable to start: %s', err));
            console.error(err.stack);
            procman.stop(1);
            return;
        }
    });
}

start();
