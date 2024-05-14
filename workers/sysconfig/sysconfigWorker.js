#!/usr/bin/env node

/**
 * @fileOverview Sysconfig worker executable.
 * Loads modules, services and does initialization.
 */

var assert    = require('assert');
var async     = require('async');
var fs        = require('fs');
var path      = require('path');
var worker    = require('nef/baseWorker');
var NefError  = require('nef/error').NefError;
var logger    = require('nef/logger');
var events    = require('nef/events');
var nefUtils  = require('nef/utils');
var WorkerAdapter = require('nef/sysconfig/workerAdapter');
var EventEmitter  = require('events').EventEmitter;
var commonConfig  = nefUtils.requireConfig('config/common');
worker.info(require('./worker.json')); // must come before API definition
var api  = require('./sysconfigApi');
var main = require('./sysconfigMain');
var sslUtils = require('nef/sslUtils');
var execFile = require('child_process').execFile;

/**
 * Function scans directory nef/configModules and loads all modules there
 */
function loadModules(done) {
    async.forEach(commonConfig.configModulesDirs,
            function(modulesDir, nextPath) {
        async.forEach(fs.readdirSync(modulesDir), function(dir, nextFile) {
            var stat;
            var modFile;
            var modPath = path.resolve(modulesDir + '/' + dir + '/' + dir +
                                       'Module.js');

            try {
                stat = fs.statSync(modPath);
            } catch (e) {
                logger.error(__('Unable to find %sModule.js in %s/%s', dir,
                             modulesDir, dir));
                return nextFile();
            }

            try {
                var modFile = require(modPath);
            } catch (e) {
                console.error(e);
                logger.error(__('Unable to load %s: %s', dir, e.toString()));
                return nextFile();
            }

            if (!modFile.hasOwnProperty('init')) {
                logger.error(__('Missing "init" method in sysconfig module %s',
                        dir, e.toString()));
                return nextFile();
            }

            async.waterfall([
                function(next) {
                    modFile.init(worker, next);
                },
                function(module, next) {
                    main.installModule(module, next);
                }
            ], function(err) {
                if (err) {
                    logger.error(__('Failed to init module %s: %s',
                                     modPath, err.toString()));
                }
                nextFile();
            });
        }, nextPath);
    }, done);
}

/**
 * Function scans database and loads all worker adapters, found there
 * At the begining all of them are in disconnected stage
 *
 * @param  {Function}     done       callback
 */
function loadWorkerAdapters(done) {

    async.waterfall([
        WorkerAdapter.init.bind(WorkerAdapter),
        WorkerAdapter.listAllAdapters.bind(WorkerAdapter),
        function(list, next) {
            async.forEach(list, function(moduleId, nextAdapter) {
                var module = new WorkerAdapter({
                    worker: worker,
                    id: moduleId,
                });
                main.installModule(module, function(err) {
                    if (err) {
                        logger.error(__('Failed to init adapter %s: %s',
                                         moduleId, err.toString()));
                    }
                    nextAdapter();
                });
            }, next);
        },
    ], done);
}

/**
 * Function scans directory with service JS modules and loads them.
 * Everything is done synchronously but for compatibility with
 * async.* it is callback style method.
 */
function loadServices(done) {

    commonConfig.configServicesDirs.forEach(function(dir) {
        fs.readdirSync(dir).forEach(function(file) {
            // skip temporary files
            if (!file.match(/.*\.js$/)) {
                return;
            }
            if (file === 'test.js' && !commonConfig.configAllowTestService) {
                logger.debug(__('Skipping test service'));
                return;
            }

            var filePath = path.join(dir, file);
            var service;

            try {
                service = require(filePath);
            } catch (e) {
                logger.error(__('Unable to load service %s: %s', filePath,
                        e.toString()));
                return;
            }
            main.installService(service);
        });
    });
    done();
}

/**
 * Function scans directory with profiles and loads them.
 * Everything is done synchronously but for compatibility with
 * async.* it is callback style method.
 */
function loadProfiles(done) {

    commonConfig.configProfilesDirs.forEach(function(dir) {
        fs.readdirSync(dir).forEach(function(file) {
            var filePath = path.join(dir, file);
            var data;
            var prof;

            if (!file.match('.*\.json$')) {
                return;
            }

            try {
                data = fs.readFileSync(filePath);
                prof = JSON.parse(data);
            } catch (e) {
                logger.error(__('Unable to load profile %s: %s', filePath,
                        e.toString()));
                return;
            }
            if (prof.version > 1) {
                logger.error(__('Cannot parse profile with ' +
                                    'future version: %d', prof.version));
                return;
            }
            assert(prof.description, 'Missing description in profile ' + file);
            main.installProfile(file.slice(0, -5), prof);
        });
    });
    done();
}

function createDir(path, done) {
    fs.stat(path, function(err) {
        if (err && err.code === 'ENOENT') {
            fs.mkdir(path, 0700, done);
            return;
        }
        done();
    });
}

function createSslDirs(done) {
    async.series([
        (next) => createDir(sslUtils.SSL_PATH, next),
        (next) => createDir(sslUtils.SSL_REQUESTS_PATH, next),
        (next) => createDir(sslUtils.SSL_KEYS_PATH, next),
        (next) => createDir(sslUtils.SSL_CAS_PATH, next),
        (next) => createDir(sslUtils.SSL_CERTIFICATES_PATH, next),
        (next) => createDir(sslUtils.SSL_OPTIONS_PATH, next),
    ], done);
}

function createLocalCa(done) {
    const name = sslUtils.LOCAL_CA_NAME;
    const subject = sslUtils.LOCAL_CA_SUBJECT;
    const days = sslUtils.LOCAL_CA_DAYS;
    const keyPath = sslUtils.getObjectPath('key', name);
    const caPath = sslUtils.getObjectPath('ca', name);
    logger.info(__('Create local certificate authority: %s', name));
    async.series([
        (next) => execFile(sslUtils.OPENSSL, ['genrsa', '-out', keyPath,
                           sslUtils.BITS], function(err) {
            if (err) {
                logger.error(__('Failed to generate certificate authority ' +
                                'root key: %s', err.toString()));
                next(err);
                return;
            }
            next();
        }),
        (next) => execFile(sslUtils.OPENSSL, ['req', '-x509', '-new', '-subj',
                           subject, '-key', keyPath, '-days', days, '-out',
                           caPath], function(err) {
            if (err) {
                logger.error(__('Failed to generate certificate authority ' +
                                'certificate: %s', err.toString()));
                next(err);
                return;
            }
            next();
        }),
        (next) => fs.chmod(keyPath, 0o400, next),
    ], done);
}

function checkLocalCa(done) {
    sslUtils.listCas(function(err, data) {
        if (err) {
            done(err);
            return;
        };

        if (data && data.length) {
            for (let i = 0; i < data.length; i++) {
                const ca = data[i];
                if (ca.name === sslUtils.LOCAL_CA_NAME) {
                    done();
                    return;
                }
            }
        }

        createLocalCa(done);
    });
}

/*
 * Worker startup code
 */
async.series([
    loadModules,
    loadWorkerAdapters,
    loadServices,
    loadProfiles,
    createSslDirs,
    checkLocalCa
], function(err) {
    if (err) {
        logger.error(__('Error loading sysconfig worker: %s', err));
        process.exit(1);
    }
    worker.start();
    events.privateEvent('NEF_sysconfig_initialized');
    process.nextTick(main.emitRebootNeededEvent);
});
