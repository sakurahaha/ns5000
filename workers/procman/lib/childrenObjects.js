/**
 * @fileOverview Describes worker process that runs as child to procman
 *
 * Specific things to any worker subprocess
 */

'use strict'

var assert = require('assert');
var async = require('async');
var path = require('path');
var fs = require('fs');
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var EventEmitter = require('events').EventEmitter;
var usage    = require('usage');

var logger = require('nef/logger');
var debug = require('nef/debug');
var NefError = require('nef/error').NefError;
var nefUtils = require('nef/utils');
var schemaUtils = require('nef/schemaUtils');
var schemas = require('../procmanSchemas');
var procmanUtils = require('../procmanUtils');
var procDb = require('../procmanDb');
var interop   = require('nef/interop');

var config = nefUtils.requireConfig('config/common');
var defaultWorkerMeta = nefUtils.requireConfig('config/defaultWorker');

const BROKER_PATH = path.join(process.env.NEF_CORE_ROOT,
                              'workers', 'procman', 'broker',
                              'main.js');

const ALLOWED_STATUSES = ['init', 'disabled', 'queued',
                          'starting', 'stopping', 'restarting',
                          'offline', 'online'];

/**
 * Basic class that incapsulates all logic to
 * spawn child process. It handles following extra things:
 *  - custom args, env, path, cwd for running process
 *  - gracefull stopping
 *  - starting with throttling of spawn calls (to not freeze loop)
 *  - formatting of output with needed prefixes
 *  - also custom handler onOnline that should be called after
 *    process considered to be online
 */
class ChildProcess extends EventEmitter {

    constructor(name) {
        super();
        this.name = name;
        this.cache = {};
        this.pid = undefined;
        this.exitReason = undefined;
        this.exitRetcode = undefined;
        this.exitSignal = undefined;
        this.startupTimeout = undefined;

        this.respawnTimer = new ReplaceableTimer();
        this.startupTimer = new ReplaceableTimer();
        this.clearSpawns();
    }

    get command() {
        // should be overwritten
        return ['echo'];
    }

    get env() {
        return nefUtils.shallowExtend({}, process.env);
    }

    get cwd() {
        return process.env.NEF_ROOT;
    }

    get running() {
        return this.pid !== undefined;
    }

    start(done) {
        this.afterStartHandler = done;
        nefUtils.throttleCalls('child-spawn', () => {
            this.spawn();
        }, config.procmanSpawnInterval);
    }

    stop(done) {
        logger.info(__('Stopping %s', this.name));
        procmanUtils.killProc(this.pid, {
            logger: logger,
            name: `${this.name} [${this.pid}]`
        }, done);
    }

    onExit(code, signal) {
        this.child = undefined;
        this.pid = undefined;
        this.exitRetcode = code;
        this.exitSignal = signal;
        this.startupTimer.clear();

        if (signal) {
            // stopEvent.signal = signal;
            logger.warn(__('Worker %s was killed by %s.', this.name, signal));
            this.exitReason = __('Killed by signal %s', signal);
        } else if (code) {
            logger.error(__('Worker %s exited with code %s.', this.name, code));
            this.exitReason =  __('Exited with code %s', code);
        } else {
            logger.info(__('Worker %s exited.', this.name));
            this.exitReason =  __('Exited with normal retcode', code);
        }

        if (this.afterStartHandler) {
            this.afterStartHandler(NefError('EFAILED',
                                             __('Exited before online: %s',
                                                this.exitReason)));
            this.afterStartHandler = undefined;
        }

        this.failSpawn();
        this.emit('exit');
    }

    onOnline() {
        logger.info(__('%s online', this.name));
        this.startupTimer.clear();
        this.clearSpawns(this.meta.respawnClearTimeout);

        if (this.afterStartHandler) {
            this.afterStartHandler();
            this.afterStartHandler = undefined;
        }

        this.emit('online');
    }

    spawn() {
        logger.info(__('Starting %s', this.name));

        this.exitReason = undefined;
        this.exitRetcode = undefined;
        this.exitSignal = undefined;

        this.newSpawn();

        if (this.startupTimeout) {
            this.startupTimer.set(() => {
                logger.warn(__('%s starts too long, stopping',
                               this.name));
                this.stop();
            }, this.startupTimeout);
        }

        var cmd = this.command;
        this.child = spawn(cmd[0], cmd.slice(1), {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: this.env,
            cwd: this.cwd
        });
        this.pid = this.child.pid;

        debug.procman.spawn(`Spawn ${this.path}, ${this.args}`);

        this.child.stdout.on('data', this.forwardOutput.bind(this, 'stdout'));
        this.child.stderr.on('data', this.forwardOutput.bind(this, 'stderr'));
        this.child.once('exit', this.onExit.bind(this));
        this.child.on('message', this.onIpcMessage.bind(this));
        this.emit('spawn');
    }

    forwardOutput(type, data) {
        var lines = data.toString().split('\n').filter(function(l) {
            return (l.length > 0);
        });

        lines.forEach((l) => this.forwardLine(type, l));
    }

    /**
     * Handle message passed via IPC
     *
     * @param {object} message
     * @param {string} message.type type of message
     * @param {string} message.worker worker name
     * @param {*} message.data message data
     */
    onIpcMessage(message) {
        if (message.type === 'exception') {
            logger.error(__('Uncaught exception in "%(worker)s" worker' +
                '\nStack: %(stack)s', {
                // there are some cases when worker name may be not defined
                // if error happened in worker before worker.info method
                // was invoked
                worker: message.worker || this.name || '',
                stack: message.data.stack
            }));
        }
    }

    forwardLine(type, line) {
        /* Ugly hack, but it's a sample from child_process manual */
        if (/^execvp\(\)/.test(line)) {
            line += ' (' + procPath + ')';
        }

        if (this.name === 'logger') {
            console.log(line);
        } else if (line.startsWith('  \u001b[3')) {
            // nef/debug output
            console.log(`  [${this.name}]${line}`);
        } else {
            line = `${this.name} ${type}: ${line}`;

            if (process.env['NEF_IS_TERMINAL']) {
                line = type === 'stdout' ? line.grey : line.red;
            }
            console.log(line);
        }
    }

    /*
     * Respawn throttling logic
     * we cound number of unsuccesful tries to start
     * each try makes next start longer and longer
     */
    newSpawn() {
        this.respawnTimer.clear();
        this.respawnId += 1;
        this.respawnDelayTo = undefined;
        this.spawnedAt = Date.now();
    }

    clearSpawns(delay) {
        this.spawnedAt = undefined;
        this.respawnTimer.set(() => {
            this.respawnId = 0;
            this.respawnDelayTo = undefined;
        }, delay || 0);
    }

    failSpawn() {
        this.respawnTimer.clear();

        if (this.respawnId > 1) {
            var power = Math.min(this.respawnId, this.meta.respawnCount);
            var delay = Math.pow(2, power - 1);

            this.respawnDelayTo = Date.now() + delay * 1000;
            logger.warn(__('Delaying restart of %s by %d seconds',
                            this.name, delay));

            this.respawnTimer.set(() => {
                this.respawnDelayTo = undefined;
                this.emit('respawnTick');
            }, delay * 1000);
        }
    }

    isRespawnDelayed() {
        return this.respawnDelayTo && Date.now() < this.respawnDelayTo;
    }
}

/**
 * This class extends ChildProcess with several specific for workers
 * things:
 *   - status, extrastatus (statusDescr)
 *   - enabled/disabled mode
 *   - async init method that should be called after constructor
 *   - different code to apply and work with per-worker configurations
 */
class WorkerChild extends ChildProcess {

    constructor(name, dir, procman) {
        super(name);
        this.workerDir = dir;
        this.procman = procman;
        this.startIndex = 999;
        this.enabled = false;
        this.enabledCause = 'Disabled by default';
        this.status = 'init';
        this.statDescr = 'Initialization';
        this.stored = new procDb.StoredWorkerData(this);
    }

    init(done) {
        async.series([
            (next) => this.loadMetaInfo(next),
            (next) => this.stored.load(next),
        ], done);
    }

    get env() {
        var env = super.env;
        env['NEF_PROCESS_TYPE'] = 'worker';
        return env;
    }

    get path() {
        if (this.meta && this.meta.path) {
            return path.join(this.workerDir, this.meta.path);
        } else {
            return path.join(this.workerDir, `${this.name}Worker.js`);
        }
    }

    get args() {
        return this.meta.args || [];
    }

    get command() {
        if (this.debug) {
            if (this.pauseOnStart) {
                return ['node', '--inspect-brk=0.0.0.0', this.path, ...this.args];
            } else {
                return ['node', '--inspect=0.0.0.0', this.path, ...this.args];
            }
        } else {
            return [this.path, ...this.args];
        }
    }

    get online() {
        return this.status === 'online';
    }

    get tags() {
        if (this.meta.tags) {
            return this.meta.tags;
        } else if (this.meta.tag) {
            return [this.meta.tag];
        } else {
            return [];
        }
    }

    get after() {
        return this.meta.after || [];
    }

    get before() {
        return this.meta.before || [];
    }

    get require() {
        return this.meta.require || [];
    }

    get debug() {
        var res = this.stored.data && this.stored.data.debug || false;
        return res && !nefUtils.envIs('production');
    }

    get heartbeatDisabled() {
        var res = this.stored.data && this.stored.data.heartbeatDisabled ||
                  false;
        return res && !this.debug;
    }

    get pauseOnStart() {
        return this.stored.data && this.stored.data.pauseOnStart || false;
    }

    /*
     * All workers that are required by this one. It doesn't
     * include recusive dependency
     */
    get requiredWorkers() {
        if (!this.cache.requiredWorker) {
            var names = this.require;

            this.cache.requiredWorkers = this.procman.workers.find(names);
        }

        return this.cache.requiredWorkers;
    }

    /*
     * All workers that requires this worker, kind of reversed
     * requiredWorkers. It doesn't include recursive dependency
     */
    get dependentWorkers() {
        if (!this.cache.dependentWorkers) {
            var res = this.procman.workers.find().filter((worker) => {
                var el = worker.requiredWorkers.indexOf(this) > -1;
                return worker.requiredWorkers.indexOf(this) > -1;
            });

            this.cache.dependentWorkers = res;
        }
        return this.cache.dependentWorkers;
    }

    /*
     * All workers that should start before this one. It includes
     * workers in this.require and this.after, and also caclulates
     * reversed dependency for this.before
     */
    get prestartedWorkers() {
        if (!this.cache.prestartedWorkers) {
            var names = [].concat(this.require).concat(this.after);

            this.procman.workers.find().forEach((worker) => {
                if (this.isInList(worker.before)) {
                    names.push(worker.name);
                }
            });

            this.cache.prestartedWorkers = this.procman.workers.find(names);
        }

        return this.cache.prestartedWorkers;
    }

    toObject() {
        return {
            name: this.name,
            tags: this.tags,
            path: this.path,
            args: this.args,
            pid: this.pid,
            status: this.status,
            statusDescription: this.statusDescr,
            enabled: this.enabled,
            enabledCause: this.enabledCause,
            online: this.online,
            running: this.pid !== undefined,
            require: this.requiredWorkers.map(w => w.name),
            after: this.prestartedWorkers.map(w => w.name),
            respawnId: this.respawnId,
            heartbeatDisabled: this.heartbeatDisabled,
            debug: this.debug,
            pauseOnStart: this.pauseOnStart,
        };
    }

    setStatus(status, descr) {
        assert(ALLOWED_STATUSES.indexOf(status) >= 0);

        if (this.status !== status) {
            debug.procman.trace(`child status: ${this.name} ` +
                                `${this.status} => ${status}`);
            this.status = status;
            this.statusDescr = undefined;
        }

        if (descr) {
            this.statusDescr = descr;
        } else if (status === 'disabled' && this.enabledCause) {
            this.statusDescr = this.enabledCause;
        }

        var event = {
            status: this.status,
            statusDescr: this.statusDescr
        };

        this.emit('statusChanged', event);
        this.emit('status:' + this.status, event);
    }

    statusIn(list) {
        return list.indexOf(this.status) > -1;
    }

    enable(opts, done) {
        done = done || this.errorLogger('Failed to enable %s: %s');
        this.toggleEnabled(true, opts, done);
    }

    disable(opts, done) {
        done = done || this.errorLogger('Failed to disable %s: %s');
        this.toggleEnabled(false, opts, done);
    }

    enableDebug(opts, done) {
        done = done || this.errorLogger('Failed to enable debug for %s: %s');
        this.toggleDebug(true, opts, done);
    }

    disableDebug(opts, done) {
        done = done || this.errorLogger('Failed to disable debug for %s: %s');
        this.toggleDebug(false, opts, done);
    }

    enableHeartbeat(opts, done) {
        done = done || this.errorLogger('Failed to enable heartbeat ' +
                                        'for %s: %s');
        this.toggleHeartbeat(true, opts, done);
    }

    disableHeartbeat(opts, done) {
        done = done || this.errorLogger('Failed to disable heartbeat ' +
                                        'for %s: %s');
        this.toggleHeartbeat(false, opts, done);
    }

    start(done) {
        done = done || this.errorLogger('Failed to start %s: %s');

        if (this.running) {
            return done();
        }

        this.setStatus('starting', __('Starting'));

        if (this.debug) {
            if (this.pauseOnStart) {
                logger.warn(__('Worker %s is starting in DEBUG mode, ' +
                               'with BREAKPOINT on first line',
                               this.name));
            } else {
                logger.warn(__('Worker %s is starting in DEBUG mode',
                               this.name));
            }
        }

        super.start(done);
    }

    stop(done) {
        done = done || this.errorLogger('Failed to stop %s: %s');

        if (!this.running) {
            return done();
        }

        this.setStatus('stopping', __('Stopping worker'));

        async.series([
            (next) => this.dumpCore(next),
            (next) => super.stop(next),
        ], (err) => {
            if (err) {
                this.setStatus('stopping', __('Failed to stop: %s',
                                              err.toString()));
            }
            done(err);
        });
    }

    restart(opts, done) {
        done = done || this.errorLogger('Failed to restart %s: %s');

        if (!this.enabled) {
            return done(NefError('EFAILED', 'Worker is disabled'));
        }

        opts = opts || {};
        if (opts.logChange) {
            logger.info(__('Restart %s: %s', this.name,
                           opts.cause || __('Missing reason')));
        }

        this.collectCore = opts.collectCore;
        this.clearSpawns();
        this.setStatus('restarting', opts.cause);
        done();
    }

    dumpCore(done) {
        if (!this.collectCore) {
            return done();
        }
        this.collectCore = false;

        if (process.platform !== 'sunos') {
            logger.debug(__('Collecting cores is not supported on %s',
                             process.platform));
            return done();
        }

        if (!config.deadWorkerCores) {
            logger.debug(__('Collecting cores is disabled'));
            return done();
        }

        exec('gcore -g ' + this.pid, (err, stdout, stderr) => {
            if (err) {
                logger.error(__('Failed to dump core of %s worker: %s',
                        this.name, stderr));
            } else {
                logger.info(__('Dumped core of %s worker: %s',
                        this.name, stdout));
            }
            done();
        });
    }

    clear(opts, done) {
        done = done || this.errorLogger('Failed to clear %s: %s');
        this.clearSpawns();
        done();
    }

    onExit(code, signal) {
        this.emit('workerStopped', {
            name: this.name,
            debug: this.debug,
            enabled: this.enabled,
            pid: this.pid || 0,
            respawnId: this.respawnId,
            exitCode: code || 0,
            signal: signal || undefined
        });

        super.onExit(code, signal);
        this.setStatus('offline', this.exitReason);
    }

    onOnline() {
        this.setStatus('online', 'Running');
        super.onOnline();
    }

    spawn() {
        super.spawn();

        this.emit('workerStarted', {
            name: this.name,
            path: this.path,
            args: this.args,
            debug: this.debug,
            heartbeatDisabled: this.heartbeatDisabled,
            pid: this.pid || 0,
            respawnId: this.respawnId,
        });
    }

    /**
     * Meta info. Each worker should have own meta info, kind of
     * static config that could be defined in worker.json in worker's tree
     * or in config/<worker>Worker.json.
     *
     * Default values for all workers are defined in config/defaultWorker.json
     **/
    loadMetaInfo(done) {
        var meta = nefUtils.shallowExtend({}, defaultWorkerMeta,
                                          this.loadLocalMeta(),
                                          this.loadMetaOverridings());
        this.meta = procmanUtils.clearMeta(meta);

        // Validate
        var err = schemaUtils.validate(this.meta, schemas.workerMeta,
                                       'Invalid worker.json', 'meta');
        if (err) {
            this.meta = {};
            return done(err);
        }

        this.warnWrongMetaInfo();
        this.startupTimeout = this.meta.startupTimeout;
        done();
    }

    loadMetaOverridings() {
        var overridingsFile = `config/${this.name}Worker`;
        return nefUtils.requireConfig(overridingsFile, {
            ignoreMissing: true
        });
    }

    loadLocalMeta() {
        var localMetaFile = path.join(this.workerDir, 'worker.json');
        try {
            var data = fs.readFileSync(localMetaFile).toString();
            return JSON.parse(data);
        } catch (err) {
            logger.warn(__('Skip local meta file for %s: %s',
                            this.name, err));
            return {};
        }
    }

    updateEnabledState(done) {
        done = done || this.errorLogger('Failed to update enabled state ' +
                                        'for %s: %s');
        withFirstDefined([
            {
                value: this.stored.data.enabled,
                source: 'Stored state',
            },
            {
                value: this.meta.enabled,
                source: 'State from worker.json'
            },
            {
                value: config.defaultWorkers.indexOf(this.name) > -1 || null,
                source: 'Listed in config/defaultWorkers'
            }
        ], (winner, next) => {
            this.toggleEnabled(winner.value, {
                cause: winner.source,
                enableRequired: true,
                disableDependent: true
            }, next);
        }, done);
    }

    warnWrongMetaInfo() {
        if (this.meta.depends) {
            logger.warn(__('Deprecated meta property "depends" for worker %s',
                            this.name));
            this.meta.after = this.meta.depends;
        }
        if (!this.meta.tag && !this.meta.tags) {
            logger.warn(__('Missing tag or tags field in meta for worker %s',
                           this.name));
        }
    }

    /**
      * Enable or disable worker
      *
      * Options:
      * @param opts.saveState      - save state into database
      * @param opts.cause          - optional cause for debugging
      * @param opts.
      */
    toggleEnabled(enabled, opts, done) {
        opts = opts || {};

        if (opts.logChange && enabled !== this.enabled) {
            var args = [this.name, opts.cause || __('missing reason')];
            var msg = enabled ? __('Enable %s: %s', ...args)
                              : __('Disable %s: %s', ...args);
            logger.info(msg);
        }

        this.enabled = enabled;
        this.enabledCause = opts.cause || undefined;
        this.clearSpawns();

        if (enabled && opts.enableRequired) {
            this.requiredWorkers.forEach((worker) => {
                var newOpts = nefUtils.shallowExtend({}, opts, {
                    cause: __('Required dependency for %s', this.name)
                });
                worker.enable(newOpts);
            });
        }

        if (!enabled && opts.disableDependent) {
            this.dependentWorkers.forEach((worker) => {
                var newOpts = nefUtils.shallowExtend({}, opts, {
                    cause: __('Required dependency %s has been disabled',
                              this.name)
                });
                worker.disable(newOpts);
            });
        }

        this.emit('enabledChanged', {
            enabled: this.enabled,
            enabledCause: this.enabledCause
        });

        if (opts.store) {
            this.stored.update({
                enabled: enabled
            }, done);
        } else {
            done();
        }

    }

    toggleHeartbeat(enabled, opts, done) {
        this.stored.update({
            heartbeatDisabled: !enabled
        }, (err) => {
            if (err) {
                return done(err);
            }

            this.emit('heartbeatDisabledChanged', {
                value: enabled
            });
            done();
        });
    }

    toggleDebug(enabled, opts, done) {
        if (nefUtils.envIs('production')) {
            return done(NefError('EFAILED',
                                 __('Debug in production is disabled')));
        }

        async.series([
            (next) => {
                this.stored.update({
                    debug: enabled,
                    pauseOnStart: opts.pauseOnStart
                }, next);
            },
            (next) => {
                if (!this.running) {
                    return next();
                }
                // is the only way how to disable debugger
                // to restart a process?
                if (enabled) {
                    // TODO: sending signal ups a debugger
                    //       but it listens by default on 127.0.0.1
                    //       WORKAROUND:
                    //       restart a worker (with enabled debug mode) or
                    //       do ssh forwarding
                    this.child.kill('SIGUSR1');
                } else {
                    this.stop();
                }
                next();
            }
        ], done);
    }

    usage(done) {
        if (!this.running) {
            return done();
        }

        usage.lookup(this.pid, (err, res) => {
            if (err) {
                logger.error(__('Failed to get usage info for %s: %s',
                                this.name, err));
                return done();
            }
            done(undefined, {
                cpu: res.cpu,
                memory: res.memory
            });
        });
    }

    isInList(lst) {
        if (lst.indexOf(this.name) > -1) {
            return true;
        }

        for (var tag of this.tags) {
            if (lst.indexOf(`tag:${tag}`) > -1) {
                return true;
            }
        }

        return false;
    }

    errorLogger(msg) {
        return (err) => {
            if (err) {
                logger.warn(__(msg, this.name, err));
            }
        };
    }
}

class UnkillableChild extends WorkerChild {
    constructor(name, dir, procman) {
        super(name, dir, procman);
        this.enabled = true;
        this.enabledCause = 'Always enabled';
        this.unkillable = true;
    }

    disable(opts, done) {
        if (done) {
            done(NefError('EFAILED', __('Worker %s can\'t be disabled',
                                        this.name)));
        }
    }

    restart(opts, done) {
        if (done) {
            done(NefError('EFAILED', __('Worker %s can\'t be restarted',
                                        this.name)));
        }
    }

    stop(done) {
        if (done) {
            done(NefError('EFAILED', __('Worker %s can\'t be stopped',
                                        this.name)));
        }
    }

    forceStop(done) {
        super.stop(done);
    }
}

/*
 * Disable some actions for procman self, when
 * it represented as object in workers collection
 */
class ProcmanChild extends UnkillableChild {

    constructor(name, dir, procman) {
        super(name, dir, procman);
        this.pid = process.pid;
        this.status = 'online';
        this.statusDescr = 'Current process';
        this.meta = {
            tags: ['core']
        };
    }

    start(done) {
        done();
    }

    setStatus(status, descr) {
        if (status === 'online') {
            super.setStatus(status, descr);
        }
        return;
    }
}

class BrokerChild extends UnkillableChild {

    constructor(procman) {
        super('broker', BROKER_PATH, procman);
    }

    init(done) {
        try {
            var meta = nefUtils.shallowExtend({}, defaultWorkerMeta, {
                tags: ['core']
            });
            this.meta = procmanUtils.clearMeta(meta);
            this.initSync();
        } catch (err) {
            return done(NefError('EINVAL',
                                 __('Failed to init broker: %s', err)));
        }
        done();
    }

    get path() {
        return BROKER_PATH;
    }

    get args() {
        return [];
    }

    get env() {
        var env = super.env;
        env['NEF_PROCESS_TYPE'] = 'broker';
        return env;
    }

    forwardLine(type, line) {
        if (line === 'BROKER READY') {
            this.onOnline();
        } else {
            super.forwardLine(type, line);
        }
    }

    /*
     * Code that is responseable to correctly
     * update broker with worker's data
     */
    initSync() {
        this.syncedWorkers = {};
        this.procman.on('workerChanged', (data) => {
            this.syncedWorkers[data.name] = false;
            this.scheduleSync();
        });
    }

    scheduleSync(...workers) {
        for (var worker of workers) {
            this.syncedWorkers[worker.name] = false;
        }

        nefUtils.debounce('broker-sync', () => {
            this.sync();
        }, 200);
    }

    sync() {
        var toSync = [];

        this.procman.workers.getNames().filter((name) => {
            if (this.syncedWorkers[name]) {
                return;
            }

            var worker = this.procman.workers.get(name);
            if (!worker) {
                return;
            }

            toSync.push({
                name: worker.name,
                pid: worker.pid,
                running: worker.running,
                enabled: worker.enabled,
                online: worker.online,
                heartbeatDisabled: worker.heartbeatDisabled,
                livenessCounter: worker.meta.livenessCounter
            });
        });

        interop.call('broker', 'updateWorkers', {
            workers: toSync
        }, (err) => {
            if (err) {
                logger.warn(__('Broker sync failed: %s', err));
            } else {
                for (var obj of toSync) {
                    this.syncedWorkers[obj.name] = true;
                }
            }
        });
    }
}

/**
 * Helper to have replaceble timer
 * that could be reset at any time, and will
 * clear itself automatically
 */
class ReplaceableTimer {
    constructor() {
        this.timer = undefined;
    }

    clear() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    set(callback, delay) {
        this.clear();
        if (delay === 0) {
            callback();
        } else {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                callback();
            }, delay);
        }
    }
}

/**
 * Helper to get first source with defined value
 * If there is no defined value, then done will be called
 * without callback
 */
function withFirstDefined(lst, callback, done) {
    for (var el of lst) {
        if (el.value != null) {
            return callback(el, done);
        }
    }
    return done();
}

module.exports.WorkerChild = WorkerChild;
module.exports.BrokerChild = BrokerChild;
module.exports.ProcmanChild = ProcmanChild;
