/*
 * Defensive logic to prevent restarting workers due to heartbeat loss under
 * high CPU load (75% and more).
 */
var MDP = require('nef/MDP');

var logger = require('nef/logger');
var nefUtils = require('nef/utils');
var defaultWorkerMeta = nefUtils.requireConfig('config/defaultWorker');

var cpuUtilizationHigh = false;
var kstat = false;

if (process.platform === 'sunos') {
    try {
        kstat = require('nef/kstat');
    } catch (err) {
        if (err.code !== 'MODULE_NOT_FOUND') {
            throw err;
        }
    }
}

if (kstat) {
    var cpuCheckActive = false;
    var cpuInstanceUtilization = {};

    setInterval(() => {
        // Don't flood with kstat requests.
        if (cpuCheckActive) {
            return;
        }

        cpuCheckActive = true;

        kstat.readStats([{
            module: 'cpu',
            name: 'sys',
            stats: ['cpu_ticks_idle', 'cpu_ticks_kernel', 'cpu_ticks_user',
                    'cpu_ticks_wait']
        }], 'misc', 'named', function(err, res) {
            var totalBusy = 0;
            var totalIdle = 0;

            cpuCheckActive = false;

            for (var stat of res) {
                var prev = cpuInstanceUtilization[stat.instance];

                if (prev) {
                    var currKern = parseInt(stat.stats['cpu_ticks_kernel']);
                    var currUser = parseInt(stat.stats['cpu_ticks_user']);
                    var currIdle = parseInt(stat.stats['cpu_ticks_idle']);
                    var currWait = parseInt(stat.stats['cpu_ticks_wait']);

                    var kern = currKern - prev.kernel;
                    var user = currUser - prev.user;
                    var idle = currIdle - prev.idle;
                    var wait = currWait - prev.wait;

                    totalBusy += (user + kern);
                    totalIdle += (idle + wait);

                    prev.idle = currIdle;
                    prev.user = currUser;
                    prev.kernel = currKern;
                    prev.wait = currWait;
                } else {
                    cpuInstanceUtilization[stat.instance] = {
                        idle: parseInt(stat.stats['cpu_ticks_idle']),
                        user: parseInt(stat.stats['cpu_ticks_user']),
                        kernel: parseInt(stat.stats['cpu_ticks_kernel']),
                        wait: parseInt(stat.stats['cpu_ticks_wait'])
                    };
                }
            }

            var total = totalBusy + totalIdle;
            if (total > 0) {
                cpuUtilizationHigh = (totalBusy / total) > 0.75;
            } else {
                cpuUtilizationHigh = false;
            }
        });
    }, (defaultWorkerMeta.livenessCounter * MDP.HB_INTERVAL) / 2);
};

function isCpuUtilizationHigh() {
    return cpuUtilizationHigh;
}

module.exports.isCpuUtilizationHigh = isCpuUtilizationHigh;
