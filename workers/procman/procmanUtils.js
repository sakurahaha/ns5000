'use strict'

var async = require('async');
var fs   = require('fs');
var path = require('path');
var nefUtils = require('nef/utils');
var NefError = require('nef/error').NefError;
var exec = require('child_process').exec;

/**
 * Updates pid file, but firstly checks that previous process
 * is not running, and if it is, then it returns error.
 *
 * @param {String}  pidFile             path to pid file to be updated
 * @param {Object}  [opts]              additional options
 * @param {Boolean} opts.killCurrent    try to kill current process
 * @param {String}  opts.processType    check process type
 *
 */
function updatePidFile(pidFile, opts, done) {
    if (nefUtils.isFunction(opts)) {
        done = opts;
        opts = {};
    }

    async.autoInject({
        currentPid: (next) => {
            fs.readFile(pidFile, (err, data) => {
                if (err && err.code !== 'ENOENT') {
                    return next(err);
                }
                return next(undefined, data ? data.toString().trim() : data);
            });
        },
        currentProcInfo: (currentPid, next) => {
            if (!currentPid) {
                return next();
            }
            getProcInfo(currentPid, opts, next);
        },
        killCurrent: (currentPid, currentProcInfo, next) => {
            if (!currentProcInfo) {
                return next();
            }

            if (opts.killCurrent) {
                return killProc(currentPid, opts.killOpts || {}, next);
            }

            next(NefError('EEXIST',
                          __('Process already running, pid: %s',
                             currentPid)));
        },
        writePid: (killCurrent, next) => {
            fs.writeFile(pidFile, process.pid, next);
        }
    }, done);
};

function removePidFileSync(pidFile) {
    try {
        fs.unlinkSync(pidFile);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            throw(err);
        }
    }
};

/**
 * Returns object if there is such process running
 * or undefined otherwise
 */
function getProcInfo(pid, opts, done) {
    if (done === undefined) {
        done = opts;
        opts = {};
    }

    async.autoInject({
        running: (next) => checkProcWithSignal(pid, next),
        extra: (running, next) => {
            if (!running || opts.skipExtra) {
                return next();
            }

            getProcExtraInfo(pid, next);
        }
    }, (err, stepResults) => {
        if (err) {
            return done(err);
        }

        if (!stepResults.running) {
            return done();
        }

        var info = nefUtils.shallowExtend({
            pid: pid,
            running: stepResults.running,
        }, stepResults.extra || {});

        // Do NEF_PROCESS_TYPE additional check if asked
        if (opts.processType && info.envLines && process.platform != 'linux') {
            var processTypeLine = `NEF_PROCESS_TYPE=${opts.processType}`;
            if (info.envLines.indexOf(processTypeLine) == -1) {
                return done();
            }
        }

        done(undefined, info);
    });
}

function checkProcWithSignal(pid, next) {
    try {
        process.kill(pid, 0);
        next(undefined, true);
    } catch (err) {
        if (err.code !== 'ESRCH') {
            next(err);
        } else {
            next(undefined, false);
        }
    };
}

function getProcExtraInfo(pid, done) {
    var res = {
        argv: [],
        envLines: []
    };

    if (process.platform === 'linux') {
        fs.readFile(`/proc/${pid}/environ`, (err, data) => {
            if (err) {
                return done(NefError('EFAILED',
                            __('Can\'t read environ: %s', stderr)));
            }

            res.envLines = data.toString().split('\0');
            done(undefined, res);
        });
    } else {
        exec('pargs -ae ' + pid, (err, stdout, stderr) => {
            if (err) {
                return done(NefError('EFAILED',
                            __('Command pargs failed: %s', stderr)));
            }

            stdout.split('\n').forEach((line) => {
                var groups = line.match(/^(envp|argv)\[\d+\]: (.*)/);
                if (!groups) {
                    return;
                } else if (groups[1] === 'argv') {
                    res.argv.push(groups[2]);
                } else if (groups[1] === 'envp') {
                    res.envLines.push(groups[2]);
                }
            });
            done(undefined, res);
        });
    }
}

/**
 * Gracefully kill given process. It firstly tries
 * to kill with SIGTERM, then if it still works,
 * uses SIGKILL, and if it still works, then
 * returns error
 *
 * Options:
 *    gracefulTimeout  - timeout for SIGTERM
 *    killTimeout      - timeout for SIGKILL
 *    logger           - logger object for verbose output
 */
function killProc(pid, opts, done) {
    if (nefUtils.isFunction(opts)) {
        done = opts;
        opts = {};
    }

    opts = nefUtils.extend({
        gracefulTimeout: 20000,
        killTimeout: 5000,
        name: pid
    }, opts || {});

    var logger = opts.logger || {
        debug: () => {},
    };

    function tryKill(signal, timeout, done) {
        var waitUntil = Date.now() + timeout;
        logger.debug(__('Killing %s with %s, timeout: %s',
                        opts.name, signal, timeout));
        // Send signal
        try {
            process.kill(pid, signal);
        } catch (err) {
            if (err.code === 'ESRCH') {
                // no target, the proc is already dead
                return done('DEAD');
            }
            return done(err);
        }

        // Wait when it exits
        async.whilst(
            () => {
                return Date.now() <= waitUntil;
            },
            (next) => {
                getProcInfo(pid, {
                    skipExtra: true
                }, (err, res) => {
                    if (!res) {
                        next(err || 'DEAD');
                    } else {
                        setTimeout(next, 100);
                    }
                });
            },
            done);
    };

    async.series([
        (next) => tryKill('SIGTERM', opts.gracefulTimeout, next),
        (next) => tryKill('SIGKILL', opts.killTimeout, next)
    ], (err) => {
        if (err === 'DEAD') {
            return done(undefined, true);
        }
        done(err || NefError('EFAILED', 'Failed to kill process'));
    });
}

function clearMeta(meta) {
    var res = nefUtils.shallowExtend(meta);
    for (var key in res) {
        if (key.endsWith('_descr')) {
            delete res[key];
        }
    }
    return res;
}

function updateHostIdFile(done) {
    async.autoInject({
        hostId: (next) => {
            // For tenants we read hostId from tenant config
            // to have 100% match with NGZ.
            if (!nefUtils.zoneIs('global')) {
                nefUtils.getTenantConfig((err, cfg) => {
                    if (!cfg || !cfg.hostId) {
                        return next(NefError(
                            'EFAILED',
                            __('hostId is missing in tenant config')));
                    }
                    next(undefined, cfg.hostId);
                });
                return;
            }

            var smbios = false;
            if (process.platform === 'sunos') {
                try {
                    smbios = require('nef/smbios');
                } catch (err) {
                    if (err.code !== 'MODULE_NOT_FOUND') {
                        throw err;
                    }
                }
            }

            if (smbios) {
                smbios.getUUID(next);
            } else {
                exec('hostid', (err, stdout, stderr) => {
                    if (err) {
                        next(err);
                    } else {
                        next(undefined, stdout);
                    }
                });
            }
        },
        update: (hostId, next) => {
            fs.writeFile(process.env.HOSTID_FILE, hostId, next);
        }
    }, done);
}

module.exports.updatePidFile = updatePidFile;
module.exports.removePidFileSync = removePidFileSync;
module.exports.getProcInfo = getProcInfo;
module.exports.killProc = killProc;
module.exports.clearMeta = clearMeta;
module.exports.updateHostIdFile = updateHostIdFile;
