'use strict'

var MDP = require('nef/MDP');
var nefUtils = require('nef/utils');
var config = nefUtils.requireConfig('config/common');
var util = require('util');
var NefError = require('nef/error').NefError;
var debug = require('nef/debug');
var EventEmitter = require('events').EventEmitter;

var brokerApi = require('./brokerApi');
var defaultWorkerMeta = nefUtils.requireConfig('config/defaultWorker');

const PREFIX_RID = (new Date().getTime()) + '-';
var nextRid = 1;

const DEFAULT_PROCMAN_DATA = {
    enabled: false,
    running: false,
    online: false,
    heartbeatDisabled: false,
    livenessCounter: defaultWorkerMeta.livenessCounter
};

class WorkerRep extends EventEmitter {

    constructor(name) {
        super();
        this.name = name;
        this.pending = {};
        this.liveness = 0;

        this.socket = undefined;
        this.id = undefined;
        this.strId = undefined;
        this.connected = false;

        this.procmanData = nefUtils.extend({
            name: name,
        }, DEFAULT_PROCMAN_DATA);

        this.resetStats();
        this.makeAlive();

        this.on('procmanChanges:heartbeatDisabled', (data) => {
            this.makeAlive();
        });
    }

    get enabled() {
        return this.procmanData.enabled;
    }

    get running() {
        return this.procmanData.running;
    }

    get online() {
        return this.procmanData.online;
    }

    get heartbeatDisabled() {
        return this.procmanData.heartbeatDisabled;
    }

    get alive() {
        var hbOk = this.liveness >= 0 || this.heartbeatDisabled;
        return this.connected && hbOk;
    }

    get livenessMax() {
        return this.procmanData && this.procmanData.livenessCounter || 5;
    }

    get pid() {
        return this.procmanData && this.procmanData.pid || undefined;
    }

    connect(socket, id) {
        if (this.connected) {
            this.disconnect();
        }

        this.id = id;
        this.strId = sanId(id);
        this.socket = socket;
        this.connected = true;
        this.stats.connectedTimes += 1;

        // Overwrite procmanData for the case
        // if it's obsolete
        this.procmanData.enabled = true;
        this.procmanData.running = true;
        this.procmanData.online = true;

        this.startHbChecker();
        this.emit('connected', {
            id: this.id
        });
    }

    disconnect() {
        this.stopHbChecker();
        var oldId = this.id;

        this.popAllPendingReq().forEach((clientReq) => {
            clientReq.errorReply('EAGAIN', __('Worker %s is recovering',
                                               this.name));
        });

        this.socket = undefined;
        this.id = undefined;
        this.strId = undefined;
        this.connected = false;
        this.emit('disconnected', {
            oldId: oldId
        });
    }

    makeAlive() {
        if (this.liveness < 0) {
            this.emit('backToLife');
        }
        this.liveness = this.livenessMax;
    }

    updateData(data) {
        for (var key in data) {
            if (data[key] !== this.procmanData[key]) {
                this.emit('procmanChanges:' + key, {
                    oldValue: this.procmanData[key],
                    value: data[key]
                });
                this.procmanData[key] = data[key];
            }
        }
    }

    routeApiCall(clientReq) {
        var method = clientReq.method;
        var args = clientReq.args;

        this.stats.requests += 1;

        if (method === 'abort') {
            // Special handling because worker likely won't
            // be able to send normal response
            // (as far as I understand during refactoring, Artem)

            this.emit('request', '-', clientReq.inputData);
            this.sendRequest(clientReq.id, clientReq.inputData);

            this.stats.responses += 1;
            this.emit('reply', '-', 'null');
            clientReq.goodReply(null);
        } else {
            var rid = this.storePendingReq(clientReq);
            this.emit('request', rid, clientReq.inputData);
            this.sendRequest(rid, clientReq.inputData);
        }

        return rid;
    }

    routeReply(workerReq) {
        var rid = workerReq.replyId;
        var replyData = workerReq.replyData;

        this.stats.responses += 1;
        var clientReq = this.extractPendingReq(rid);

        if (!clientReq) {
            this.stats.protocolErrors += 1;
            logger.error(__('Received not identifier reply from ' +
                            '%s: request %s, pending message ' +
                            'absent (possibly double response)',
                            this.name, rid));
            logger.error(__('Reply content: %s', replyData));
        }

        this.emit('reply', rid, replyData);
        clientReq.sendReply(replyData);

        return rid;
    }

    //
    // PRIVATE
    //

    stopHbChecker() {
        if (this.hbChecker) {
            clearInterval(this.hbChecker);
        }
        this.makeAlive();
    }

    startHbChecker() {
        this.hbChecker = setInterval(() => {
            if (!this.online || this.procmanData.heartbeatDisabled) {
                this.makeAlive();
            }

            this.liveness --;

            if (this.liveness < 0) {
                this.stats.failedHeartbeats += 1;
                this.emit('failedHeartbeat');
            } else if (this.livenessMax - this.liveness >= 2) {
                this.stats.missedHeartbeats += 1;
            }

            this.socket.send([this.id, '', MDP.W_WORKER,
                              MDP.W_HEARTBEAT]);
        }, MDP.HB_INTERVAL);
    }

    resetStats() {
        this.stats = {
            connectedTimes: 0,
            requests: 0,
            responses: 0,
            protocolErrors: 0,
            failedHeartbeats: 0,
            missedHeartbeats: 0
        };
    }

    incStats(key, interval) {
        interval = interval || 1;
        this.stats[key] += interval;
    }

    storePendingReq(clientReq) {
        var newRid = PREFIX_RID + (++nextRid);
        this.pending[newRid] = clientReq;
        return newRid;
    }

    extractPendingReq(rid) {
        var res = this.pending[rid];
        delete this.pending[rid];
        return res;
    }

    popAllPendingReq() {
        var res = [];
        for (var rid in this.pending) {
            res.push(this.pending[rid]);
        }
        this.pending = {};
        return res;
    }

    sendRequest(rid, msg) {
        if (!this.connected) {
            return;
        }

        this.socket.send([
            this.id,
            '',
            MDP.W_WORKER,
            MDP.W_REQUEST,
            rid,
            ''
        ].concat(msg));
    };

}

class BrokerWorkerRep extends WorkerRep {
    // Overriding for broker self, it's also kind of worker
    // that always online, and doesn't use ZMQ for RPC

    constructor(broker) {
        super('broker');
        this.broker = broker;
        nefUtils.shallowExtend(this.procmanData, {
            running: true,
            enabled: true
        });
    }

    get alive() {
        return true;
    }

    routeApiCall(clientReq) {
        var handler = brokerApi.handleCall.bind(this.broker);

        this.stats.requests += 1;
        this.emit('request', '-', clientReq.inputData);
        handler(clientReq.input, (err, res) => {
            var replyData = clientReq.formatReply(err, res);

            this.stats.responses += 1;
            this.emit('reply', '-', replyData);
            clientReq.sendReply(replyData);
        });
    }

    routeReply(workerReq) {
        workerReq.errorReply('EINVAL', __('Route reply for broker ' +
                                          'is not supported'));
    }

    startHbChecker() {
        // no HB checker from broker to broker
    }
}

class WorkerRepCollection {
    constructor() {
        this.byId = {};
        this.byName = {};
    }

    get names() {
        return Object.keys(this.byName);
    }

    get all() {
        return Object.keys(this.byName).map((name) => this.byName[name]);
    }

    find(key) {
        if (!key) {
            return undefined;
        }
        key = sanId(key);

        return this.byId[key] ||
               this.byName[key] ||
               undefined;

    }

    add(worker) {
        if (this.byName[worker.name]) {
            console.error('New worker %s added when already used name',
                           worker.name);
        }
        this.byName[worker.name] = worker;

        worker.on('connected', (data) => {
            var id = sanId(data.id);
            if (this.byId[id]) {
                console.error('Worker %s connected to already used Id',
                               worker.name);
            }
            this.byId[id] = worker;
        });

        worker.on('disconnected', (data) => {
            var id = sanId(data.oldId);
            delete this.byId[id];
        });

        return worker;
    }

    withRunning(key, callback, done) {
        var worker = this.find(key);
        // We want to return a code which is rare enough not to be confused
        // with error code from any worker.
        if (worker === undefined) {
            done(NefError('ESRCH', __('Unknown worker: %s', sanId(key))));
            return;
        }

        if (!worker.enabled) {
            done(NefError('ESRCH', __('Disabled worker: %s', sanId(key))));
            return;
        }

        if (!worker.running) {
            done(NefError('ESRCH', __('Offline worker: %s', sanId(key))));
            return;
        }

        if (callback.length === 1) {
            callback(worker);
            done();
        } else {
            callback(worker, done);
        }
    }

    withAlive(key, callback, done) {
        this.withRunning(key, (worker, next) => {
            if (!worker.alive) {
                next(NefError('EAGAIN', __('Worker %s is recovering',
                                           sanId(key))));
                return;
            }

            if (callback.length === 1) {
                callback(worker);
                next();
            } else {
                callback(worker, next);
            }
        }, done);
    }
}

function sanId(id) {
    if (id === undefined || typeof(id) === 'String') {
        return id;
    }
    return id.toString('hex');
}

function cleanMeta(meta) {
    var res = {};

}

module.exports.WorkerRep = WorkerRep;
module.exports.BrokerWorkerRep = BrokerWorkerRep;
module.exports.WorkerRepCollection = WorkerRepCollection;

