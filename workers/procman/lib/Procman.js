/**
 * @fileOverview Main procman class
 *
 * This class holds and maintains logic to start, stop, restart,
 * enable, disable and so on for all children processes
 */

'use strict'

var assert = require('assert');
var async = require('async');
var path = require('path');
var fs = require('fs');
var _ = require('lodash');

var logger = require('nef/logger');
var debug = require('nef/debug');
var NefError = require('nef/error').NefError;
var nefUtils = require('nef/utils');
var events = require('nef/events');

var EventEmitter = require('events').EventEmitter;

var worker = require('nef/baseWorker');
var config = nefUtils.requireConfig('config/common');

var procDb = require('../procmanDb');
var cpuCheck = require('./cpuCheck');
var children = require('./childrenObjects');
var MemleakGuard = require('./MemleakGuard');

const SPAWN_TIMEOUT = config.procmanSpawnWait;

class Procman extends EventEmitter {

    constructor() {
        super();

        this.state = 'init';
        this.workers = new Workers();
        this.supervisor = new Supervisor(this);
        this.memleakGuard = new MemleakGuard(this);
    }

    init(opts, done) {
        opts = opts || {};
        worker.onExit(this.onExit.bind(this));

        // Init internal env variables
        if (process.stdout.columns) {
            process.env['NEF_IS_TERMINAL'] = 1;
        }
        process.env['DEBUG_COLORS'] = 'yes';

        if (opts.colors) {
            process.env['NEF_FORCE_COLORS'] = 1;
        }

        // Subscribe to broker events
        // to establish our internal logic
        events.private.on('NEF_broker_worker_connected',
                          this.onWorkerConnected.bind(this));

        events.private.on('NEF_broker_worker_disconnected',
                          this.onWorkerDisconnected.bind(this));

        events.private.on('NEF_broker_worker_failedHb',
                          this.onWorkerMissedHb.bind(this));

        events.private.on('NEF_broker_worker_recovered',
                          this.onWorkerRecovered.bind(this));

        // Async initialization
        async.series([
            next => procDb.init(opts.resetDb, next),
            next => this.startBroker(next),
            next => this.scan(next),
            next => this.workers.updateIndicies(next),
            next => this.workers.updateEnabledState(opts, next)
        ], done);
    }

    start(done) {
        this.state = 'starting';
        logger.info(__('Starting NEF in %s environment',
                        process.env.NEF_ENV));

        async.series([
            (next) => worker.start(next),
            (next) => this.memleakGuard.reschedule(next),
            (next) => this.supervisor.start(next),
        ], done);
    }

    stop(retcode) {
        worker.exit(retcode);
    }

    getStatus() {
        return {
            pid: process.pid,
            state: this.state
        };
    }

    //
    // PRIVATE
    //

    // Events related logic, those handlers responds to events
    // emitted by broker about different state changes for
    // connected workers
    onWorkerConnected(data) {
        var worker = this.workers.get(data.name);

        if (!worker) {
            logger.info(__('Unknown worker %s online', data.name));
        } else {
            worker.onOnline();
        }

        events.jointEvent('NEF_procman_process_online', data.name);
        this.supervisor.run();
    }

    onWorkerDisconnected(data) {
        events.jointEvent('NEF_procman_process_offline', data.name);
        this.supervisor.run();
    }

    onWorkerMissedHb(data) {
        var worker = this.workers.get(data.name);
        if (!worker || !worker.online || worker.heartbeatDisabledChanged) {
            return;
        }

        if (cpuCheck.isCpuUtilizationHigh()) {
            if (!worker.cpuCheckSpamed) {
                logger.warn(__('%s failed HB check. Hold it while ' +
                               'CPU is under high load', worker.name));
                worker.cpuCheckSpamed = true;
            }
            return;
        }

        logger.warn(__('Restarting %s because it fails HB check',
                       worker.name));

        worker.restart({
            cause: 'Failed HB check',
            collectCore: true,
        });
    }

    onWorkerRecovered(data) {
        // Good to know

        var worker = this.workers.get(data.name);
        if (!worker) {
            return;
        }

        worker.cpuCheckSpamed = false;
    }

    /*
     * Scanning procedure
     */
    scan(done) {
        async.each(config.workersDirs, (dir, next) => {
            fs.readdir(dir, (err, names) => {
                if (err) {
                    logger.warn(__('Failed to read workers from dir %s: %s',
                                   dir, err.toString()));
                    return next();
                }

                async.each(names, (name, next) => {
                    var workerDir = path.join(dir, name);

                    this.loadWorker(name, workerDir, (err) => {
                        if (err) {
                            logger.warn(__('Failed to load worker ' +
                                           '%s at %s: %s',
                                           name, workerDir, err.toString()));
                        }
                        next();
                    });
                }, next);
            });
        }, done);
    }

    loadWorker(name, dir, done) {
        if (this.workers.get(name)) {
            return done(NefError('EINVAL',
                        __('Worker with name %s is already loaded', name)));
        }

        fs.stat(dir, (err, stat) => {
            if (err) {
                return done(err);
            }

            if (!stat.isDirectory()) {
                return done();  // emerg exit from the loadWorker
            }

            try {
                if (name === 'procman') {
                    var worker = new children.ProcmanChild(name, dir, this);
                } else {
                    var worker = new children.WorkerChild(name, dir, this);
                }

            } catch (err) {
                return done(NefError('EINVAL', __('Failed to load %s: %s',
                                                  name, err.toString())));
            }

            worker.init((err) => {
                if (err) {
                    return done(err);
                }
                this.workers.add(worker);
                this.subscribeToWorker(worker);
                done();
            });
        });
    }

    subscribeToWorker(worker) {

        // All those events sigifies that worker
        // is changed, and we have to push things
        // like supervisor tick or broker sync
        ['spawn', 'online', 'exit',
         'statusChanged', 'heartbeatDisabledChanged',
         'enabledChanged', 'respawnTick'].forEach((event) => {
            worker.on(event, (data) => {
                this.emit('workerChanged', {
                    name: worker.name,
                    event: event,
                    eventData: data
                });
            });
        });

        worker.on('workerStarted', (data) => {
            events.jointEvent('NEF_procman_process_started', data);
        });

        worker.on('workerStopped', (data) => {
            events.jointEvent('NEF_procman_process_stopped', data);
        });
    }

    checkStartComplete() {
        var online = [];
        var failed = [];
        var stillWait = [];

        this.workers.find({
            enabled: true
        }).forEach((worker) => {
            if (worker.status === 'online') {
                online.push(worker.name);
            } else if (['offline', 'stopping'].indexOf(worker.status) > -1) {
                failed.push(worker.name);
            } else {
                stillWait.push(worker.name);
            }
        });

        if (stillWait.length > 0) {
            return;
        }

        this.state = 'online';
        if (failed.length > 0) {
            logger.error(__('%(app)s started with problems. ' +
                            '%(online)d workers are running, ' +
                            '%(failed)d failed: %(flist)s', {
                                app: config.procmanAppIdent,
                                online: online.length,
                                failed: failed.length,
                                flist: failed.join(', ')
                            }));
        } else {
            logger.info(__('%(app)s started. %(online)d workers are running', {
                app: config.procmanAppIdent,
                online: online.length
            }));
        }

        events.jointEvent('NEF_procman_start_complete', {
            online: online.length,
            failed: failed.length,
            failedWorkers: failed
        });
    }

    onExit(done) {
        logger.info(__('Shutdown %s', config.procmanAppIdent));
        this.state = 'stopping';
        this.shutdownCallback = done;
        this.supervisor.run();
    }

    checkStopComplete() {
        var stillWait = this.workers.find({
            running: true,
            killable: true
        });

        if (stillWait.length > 0) {
            return;
        }

        async.series([
            (next) => {
                if (!this.broker) {
                    return next();
                }

                this.broker.forceStop(next);
            },
            (next) => procDb.fini(next),
        ], (err) => {
            logger.info(__('Shutdown complete'));
            this.shutdownCallback(err);
        });

    }

    startBroker(done) {
        this.broker = new children.BrokerChild(this);
        this.workers.add(this.broker);

        this.broker.on('exit', () => {
            if (this.state !== 'stopping') {
                logger.error('Broker exited. Stopping NEF');
                this.stop(1);
            }
        });

        async.series([
            (next) => this.broker.init(next),
            (next) => this.broker.start(next),
        ], done);
    }
};

/*
 * Supervisor logic - is a main loop that walks thru all
 * enabled workers and stop/start what should be stopped
 * or started. It also responsible to update statuses for
 * workers, why they are queued and so on
 */
class Supervisor {

    constructor(procman) {
        this.procman = procman;
        this.timer = undefined;

        this.procman.on('workerChanged', () => this.run());
    }

    start(done) {
        this.run(done);
    }

    stop() {
        if (this.timer) {
            clearTimeout(this.timer);
        }
    }

    reschedule() {
        this.stop();
        this.timer = setTimeout(() => {
            this.run();
        }, config.procmanSupervisorInterval * 1000);
    }

    run(done) {
        done = done || (() => {});

        if (this.running) {
            return done();
        }

        this.reschedule();
        nefUtils.debounce('supervisor-tick', () => {
            this.running = true;
            try {
                this.tick();
            } catch (err) {
                logger.error(__('Supervisor tick error: %s', err.toString()));
            }
            this.running = false;
        }, 50);

        done();
    }

    /**
     * main supervisor tick
     * it should be quick!
     */
    tick() {
        debug.procman.trace('Supervisor tick');

        if (this.procman.state === 'stopping') {
            this.procman.workers.find({
                running: true,
                killable: true,
                statusNotIn: ['stopping']
            }).forEach((worker) => {
                worker.stop();
            });

            this.procman.checkStopComplete();
            return;
        }

        this.procman.workers.find({
            disabled: true,
            statusNotIn: ['disabled', 'stopping']
        }).forEach((worker) => {
            if (worker.running) {
                worker.stop();
            } else {
                worker.setStatus('disabled');
            }
        });

        this.procman.workers.find({
            enabled: true,
            statusNotIn: ['queued', 'starting', 'stopping']
        }).forEach((worker) => {
            if (!worker.running && !worker.isRespawnDelayed()) {
                worker.setStatus('queued', __('Waiting in the queue'));
            } else if (worker.status === 'restarting') {
                worker.stop();
            }
        });

        this.procman.workers.find({
            enabled: true,
            status: 'queued',
        }).forEach((worker) => {
            var deps = [];
            var failedDeps = [];

            // Get required dependency. If there are problems,
            // alls add them into faildDeps
            worker.requiredWorkers.forEach((w) => {
                if (!w.enabled || w.status == 'online') {
                    return false;
                }

                if (w.status === 'offline') {
                    failedDeps.push(w.name);
                }

                deps.push(w.name);
            });

            worker.prestartedWorkers.filter((w) => {
                if (w.status === 'queued') {
                    deps.push(w.name);
                } else if (['stopping', 'starting'].indexOf(w.status) > -1) {
                    var spawnedAt = w.spawnedAt || Date.now();
                    var tooLong = spawnedAt + SPAWN_TIMEOUT < Date.now();
                    if (!tooLong) {
                        deps.push(w.name);
                    }
                }
            });

            if (failedDeps.length > 0) {
                var names = nefUtils.unique(failedDeps);
                worker.setStatus('offline', __('Failed dependency: %s',
                                                names.join(', ')));
            } else if (deps.length > 0) {
                var names = nefUtils.unique(deps);
                worker.setStatus('queued', __('Waiting for: %s',
                                               names.join(', ')));
            } else {
                worker.start();
            }
        });

        if (this.procman.state === 'starting') {
            this.procman.checkStartComplete();
        }
    }

}

/*
 * Small collection class
 * that hides collection operations, find procedure
 * and some ordering/dependency resolving logic
 */
class Workers {
    constructor(procman) {
        this.dict = [];
        this.procman = procman;
    }

    /*
     * Collection operations
     */

    getNames() {
        return Object.keys(this.dict);
    }

    get(name) {
        return this.dict[name];
    }

    add(worker) {
        this.dict[worker.name] = worker;
    }

    remove(name) {
        delete this.dict[name];
    }

    with(name, callback, done) {
        var worker = this.get(name);
        if (worker === undefined) {
            done(NefError('ENOENT', __('Unknown worker name: %s', name)));
        }

        if (callback.length === 1) {
            callback(worker);
            done();
        } else {
            callback(worker, done);
        }
    }

    /*
     * @param {Object}  [opts]          options for search, sorting, etc ...
     * @param {String*} [opts.names]    set of names or tags for workers that
     *                                  should be returned
     * @param {Boolean} [opts.enabled]  return only enabled workers
     */
    find(opts) {
        if (nefUtils.isArray(opts)) {
            opts = {
                names: opts
            };
        };
        opts = opts || {};
        var names = opts.names || this.getNames();

        var _tagToNames = (tag) => {
            return _(this.getNames()).filter((name) => {
                return this.get(name).tags.indexOf(tag) >= 0;
            }).value();
        };

        var _expandTags = (names) => {
            return _(names).map((name) => {
                if (name.startsWith('tag:')) {
                    return _tagToNames(name.slice(4));
                } else {
                    return name;
                }
            }).flatten().compact().uniq().value();
        };

        var res = [];

        _expandTags(names).forEach((name) => {
            var worker = this.get(name);

            if (worker === undefined) {
                logger.warn(__('Ignore missing worker %s', name));
                return;
            }

            var status = worker.status;
            if ((opts.enabled && !worker.enabled) ||
                (opts.disabled && worker.enabled) ||
                (opts.running && !worker.running) ||
                (opts.killable && worker.unkillable) ||
                (opts.status && opts.status !== status) ||
                (opts.statusIn && !worker.statusIn(opts.statusIn)) ||
                (opts.statusNotIn && worker.statusIn(opts.statusNotIn))) {
                return;
            }

            res.push(worker);
        });

        return res;
    }

    //
    // Function chekcs for looped dependencies, loops in after/before
    // lists, and index each worker with unique startIndex, that could
    // be used to sort all workers according to start order
    // (so reversed list means stop order)
    //
    updateIndicies(done) {
        var matrix = {};

        var _addDep = (obj, subj) => {
            matrix[obj] = matrix[obj] || new Set([]);
            matrix[obj].add(subj);
        };

        var _reduceDep = (name) => {
            for (var el in matrix) {
                matrix[el].delete(name);
            }
        };

        var _noDeps = (name) => {
            return !(name in matrix) || matrix[name].size === 0;
        };

        this.find().forEach((worker) => {
            this.find(worker.before).forEach((w) => {
                _addDep(w.name, worker.name);
            });

            this.find(worker.require).forEach((w) => {
                _addDep(worker.name, w.name);
            });

            this.find(worker.after).forEach((w) => {
                _addDep(worker.name, w.name);
            });
        });

        var unindexed = new Set(this.getNames());

        var idx = 1;
        while (unindexed.size > 0) {
            var found = false;

            for (var name of unindexed) {
                if (_noDeps(name)) {
                    this.get(name).startIndex = idx;
                    idx += 1;
                    _reduceDep(name);
                    unindexed.delete(name);
                    found = true;
                }
            }

            if (!found) {
                var deps = Array.from(unindexed).map((name) => {
                    return `${name} on ${Array.from(matrix[name])}`;
                }).join('\n  ');

                var msg = __('Found recusive dependency.' +
                             ' Unresolved dependencies: \n  %s', deps);
                return done(NefError('EINVAL', msg));
            }
        }

        done();
    }

    updateEnabledState(opts, done) {
        var strictList = opts.startWorkersOnly || opts.startWorkers;

        if (!strictList) {
            this.find({
                killable: true
            }).forEach((worker) => worker.updateEnabledState());
        } else {
            // Disable all workers then enable only those
            // that should be enabled

            this.find({
                killable: true,
            }).forEach((worker) => worker.disable({
                cause: __('Missed in command line arguments')
            }));

            this.find(opts.startWorkers || []).forEach((worker) => {
                worker.enable({
                    cause: __('Listed as -j argument'),
                    enableRequired: true,
                });
            });

            this.find(opts.startWorkersOnly || []).forEach((worker) => {
                worker.enable({
                    cause: __('Listed as -J argument'),
                });
            });
        }

        this.find(opts.skipWorkers || []).forEach((worker) => {
            worker.disable({
                cause: 'Listed in -s argument'
            });
        });

        done();
    }
}

module.exports = Procman;

