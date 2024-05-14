
'use strict'

var async = require('async');
var fs = require('fs');
var path = require('path');
var nefUtils = require('nef/utils');
var logger = require('nef/logger');
var procmanUtils = require('../procmanUtils');

var commonConfig = nefUtils.requireConfig('config/common');
var MEMORY_LOG_FILE = '/var/log/nef.memory.stats';

class MemleakGuard {
    constructor(procman) {
        this.timer = undefined;
        this.procman = procman;
    }

    reschedule(interval, done) {
        if (nefUtils.isFunction(interval)) {
            done = interval;
            interval = undefined;
        }
        done = done || (() => {});
        interval = interval || commonConfig.memleakGuardInterval * 1000;

        this.stop();
        this.timer = setInterval(() => {
            this.run();
        }, interval);

        done();
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    run() {
        nefUtils.debounce('memory-guard-tick', () => {
            this.running = true;
            try {
                this.check((err) => {
                    if (err) {
                        logger.error(__('Memleak Guard error: %s',
                                        err.toString()));
                    }
                });
            } catch (err) {
                logger.error(__('Memleak Guard exception: %s',
                                err.toString()));
            }
        }, 200);
    }

    check(done) {
        var workers = this.procman.workers.find({
            enabled: true,
            status: 'online',
        });

        var stats = {};

        async.forEach(workers, (worker, next) => {
            if (!worker.meta.memleakGuardEnabled) {
                return next();
            }

            worker.usage((err, res) => {
                if (err) {
                    logger.error(__('Memleak Guard failed to check %s: %s',
                                    worker.name, err.toString()));
                    return next();
                }

                var usedMemory = Math.round(res.memory / 1024 / 1024);
                stats[worker.name] = {
                    memory: usedMemory
                };

                if (worker.unkillable) {
                    return next();
                }

                if (usedMemory <= worker.meta.memleakGuardTrigger) {
                    return next();
                }

                logger.error(__('Restart worker %s, it took too much ' +
                                'memory: %sMB > %sMB (trigger)',
                                worker.name, usedMemory,
                                worker.meta.memleakGuardTrigger));

                worker.restart({
                    cause: 'Exceeded memory threshold',
                    collectCore: worker.meta.memleakGuardCollectCore
                }, next);
            });
        }, (err, res) => {
            if (err) {
                return done(err);
            }

            this.saveMemoryStats(stats, done);
        });
    }

    saveMemoryStats(stats, done) {
        if (!commonConfig.memleakGuardSaveHistory) {
            return done();
        }
        try {
            var data = JSON.stringify({
                time: new Date().toISOString(),
                stats: stats
            }) + '\n';
        } catch (err) {
            logger.error(__('Failed to stringify memory stats: %s',
                            err.toString()));
            return done();
        }

        fs.appendFile(MEMORY_LOG_FILE, data, (err) => {
            if (err) {
                logger.error(__('Failed to save memory stats: %s',
                                err.toString()));
            }
            done();
        });
    }
}

module.exports = MemleakGuard;
