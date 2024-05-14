'use strict'

var fs = require('fs');
var zmq = require('zmq');
var assert = require('assert');
var EventEmitter = require('events').EventEmitter;
var events = require('nef/events');
var MDP = require('nef/MDP');
var logger = require('nef/logger');
var NefError = require('nef/error').NefError;
var workerRep = require('./workerRep');
var marshal = require('nef/marshal');
var nefUtils = require('nef/utils');
var procmanUtils = require('../procmanUtils');

var debug = require('nef/debug');
var BrokerDTP = require('./BrokerDTP');
var dtp = new BrokerDTP();

var config = nefUtils.requireConfig('config/common');

/*
 * Time between a worker is detected to be offline and time it is removed.
 * This gives time to procman to restart the worker and get it online again.
 */
// var PROTECT_TIME   = 10; // in seconds

events.declare('NEF_broker_worker_connected', {
    description: 'Worker connected',
    range: 'private',
    payload: {
        type: 'object'
    }
});

events.declare('NEF_broker_worker_disconnected', {
    description: 'Worker disconnected',
    range: 'private',
    payload: {
        type: 'object'
    }
});

events.declare('NEF_broker_worker_failedHb', {
    description: 'Worker missed too many heartbeats',
    range: 'private',
    payload: {
        type: 'object'
    }
});

events.declare('NEF_broker_worker_recovered', {
    description: 'Worker has been recovered after HB failure',
    range: 'private',
    payload: {
        type: 'object'
    }
});

class Broker {

    constructor() {
        this.sockets = [];
        this.workers = new workerRep.WorkerRepCollection();
    }

    init(done) {
        var brokerWorker = new workerRep.BrokerWorkerRep(this);
        this.workers.add(brokerWorker);
        this.subscribeToWorker(brokerWorker);

        var procmanWorker = new workerRep.WorkerRep('procman');
        this.workers.add(procmanWorker);
        this.subscribeToWorker(procmanWorker);
        procmanWorker.updateData({
            running: true,
            enabled: true,
            online: true,
            livenessCounter: 60
        });

        procmanWorker.on('failedHeartbeat', () => {
            this.dieIfProcmanDown();
        });

        this.openSockets();
        done();
    }

    shutdown() {
        this.closeSockets();
        process.exit(2);
    }

    //
    // Manage sockets. There is no many of them
    // to have dedicate class for this, hence
    // move them into Broker class
    //
    openSockets() {
        // IPC socket
        var file = config.mdpBrokerIPCFile;
        var ipcSocket = new BrokerSocket(this, 'ipc',
                                         `ipc://${file}`);
        this.sockets.push(ipcSocket);
        this.subscribeToSocket(ipcSocket);

        // TCP socket
        var host = config.mdbBrokerPublic ? '*' : '127.0.0.1';
        var port = config.mdpBrokerPort;
        var tcpSocket = new BrokerSocket(this, 'tcp',
                                         `tcp://${host}:${port}`);
        this.sockets.push(tcpSocket);
        this.subscribeToSocket(tcpSocket);
    }

    closeSockets() {
        this.sockets.forEach((socket) => socket.shutdown());
        this.sockets = [];
    }

    //
    // Main routing logic for incoming ZMQ messages
    // There are 2 types of messages: from client and from workers
    // Hence 2 main handlers here
    //
    onMessage(req) {
        if (!req || !req.valid) {
            return;
        }

        try {
            if (req.cmd === MDP.W_WORKER) {
                this.onWorkerMessage(req);
            } else if (req.cmd === MDP.C_CLIENT) {
                this.onClientMessage(req);
            }
        } catch (err) {
            console.error('ZMQ message routing error: %s',
                          err.toString());
            console.error('Failed request: %s', req.toString());
        }
    }

    // Handler for clients message. There is only one type
    // of expected messages from clients - RPC call to the worker
    // hence logic is very simple
    onClientMessage(clientReq) {
        var name = clientReq.workerName;

        this.workers.withAlive(name, (worker) => {
            worker.routeApiCall(clientReq);
        }, (err) => {
            if (err) {
                return clientReq.errorReply(err);
            }
        });
    }

    // Handler for messages from workers. It could be one of:
    // ready/disconnect when worker starts/stops. Heartbeat
    // messages, and replies to clients
    //
    // If worker wants to ask another worker, then it have
    // to create own client connection, and use it for RPC calls
    onWorkerMessage(workerReq) {

        if (workerReq.wcmd == MDP.W_READY) {
            this.connectWorker({
                id: workerReq.id,
                name: workerReq.msg[4].toString(),
                socket: workerReq.socket,
                input: (workerReq.msg[5] || '').toString()
            });
        } else if (workerReq.wcmd == MDP.W_DISCONNECT) {
            this.disconnectWorker({
                id: workerReq.id,
                name: workerReq.msg[4].toString()
            });
        } else if (workerReq.wcmd == MDP.W_HEARTBEAT) {
            this.workers.withRunning(workerReq.id, (worker) => {
                worker.makeAlive();
            }, (err) => {
                if (err) {
                    return workerReq.errorReply(err);
                }
            });
        } else if (workerReq.wcmd == MDP.W_REPLY) {
            this.workers.withAlive(workerReq.id, (worker) => {
                worker.routeReply(workerReq);
            }, (err) => {
                if (err) {
                    return workerReq.errorReply(err);
                }
            });
        } else {
            workerReq.errorReply('EINVAL', __('Invalid onWorker command: ',
                                              req.wcmd));
        }
    }

    //
    // Workers registration and handling. It's normally wrappers
    // around add/remove methods in WorkerRepCollection, but it also
    // should emit NEF events online/offline, and do more sofisticated checks
    //
    connectWorker(args) {
        var worker = this.workers.find(args.name);

        if (!worker) {
            worker = new workerRep.WorkerRep(args.name);
            this.workers.add(worker);
            this.subscribeToWorker(worker);
        }

        worker.connect(args.socket, args.id);
        events.privateEvent('NEF_broker_worker_connected', {
            name: worker.name
        });

        debug.broker.trace('Connect %s', worker.name);
    }

    disconnectWorker(args) {
        var worker = this.workers.find(args.id);

        if (!worker) {
            debug.broker.workerReqErr('Disconnect from unknown ' +
                                      'worker: %s', args.id);
            return;
        }

        worker.disconnect();

        events.privateEvent('NEF_broker_worker_disconnected', {
            name: worker.name
        });
        debug.broker.trace('Disconnect %s', worker.name);
    }

    subscribeToWorker(worker) {

        worker.on('request', (rid, data) => {
            dtp.request(worker.name, data);
            debug.broker.apiReq('>> %s [%s] %s', worker.name, rid,
                                debug.strip(data, 40));
        });

        worker.on('reply', (rid, data) => {
            dtp.reply(worker.name, data);
            debug.broker.apiRep('<< %s [%s] %s', worker.name, rid,
                                debug.strip(data, 40));
        });

        worker.on('backToLife', () => {
            events.privateEvent('NEF_broker_worker_recovered', {
                name: worker.name,
            });
        });

        worker.on('failedHeartbeat', () => {
            events.privateEvent('NEF_broker_worker_failedHb', {
                name: worker.name,
                liveness: worker.liveness
            });
        });

        debug.broker.trace('Register %s', worker.name);
    }

    subscribeToSocket(socket) {
        socket.on('message', this.onMessage.bind(this));
    }

    dieIfProcmanDown() {
        var procmanWorker = this.workers.find('procman');
        if (!procmanWorker) {
            console.error('Cant find procman worker. Shutdown');
            return this.shutdown();
        }

        if (!procmanWorker.pid) {
            console.error('Procman pid is unknown and it fails HB check.' +
                          ' Shutdown');
            return this.shutdown();
        }

        procmanUtils.getProcInfo(procmanWorker.pid, {
            processType: 'procman'
        }, (err, res) => {
            if (!err && !res) {
                console.error('Procman [pid: %s] is down. Shutdown too',
                              procmanWorker.pid);
                return this.shutdown();
            }
        });
    }
}

class BrokerSocket extends EventEmitter {

    constructor(broker, id, endpoint) {
        super();
        this.id = id;
        this.broker = broker;
        this.endpoint = endpoint;
        this.zmqSocket = zmq.socket('router');
        this.zmqSocket.bindSync(this.endpoint);
        this.zmqSocket.on('message', (...msg) => {
            var req = createBrokerRequest(this, msg);
            this.emit('message', req);
        });

        debug.broker.trace(`Opened socket '${id}' at ${endpoint}`);
    }

    shutdown() {
        this.zmqSocket.close();
        debug.broker.trace(`Closed socket '${this.id}'`);
    }

    send(msg) {
        this.zmqSocket.send(msg);
    }
}

class BrokerRequest {

    constructor(socket, msg) {
        this.socket = socket;
        this.msg = msg;
        this.id = msg[0];
        this.cmd = msg[2].toString();

        try {
            this.parse();
            this.valid = true;
        } catch (err) {
            this.errorReply('EINVAL', __('Error parsing query: %s',
                                         err.toString()));
            this.valid = false;
        }
    }

    errorReply(code, msg) {
        var err;

        if (nefUtils.isObject(code)) {
            err = code;
        } else {
            err = NefError(code, msg);
        }

        this.reply(err);
    }

    goodReply(data) {
        this.reply(undefined, data);
    }

    reply() {
        throw Error('Not implemented');
    }

    parse() {
        throw Error('Not implemented');
    }
}

class BrokerClientRequest extends BrokerRequest {

    constructor(socket, msg) {
        super(socket, msg);
        this.replied = false;
    }

    toString() {
        return nefUtils.format('<clientReq to: %s, input: %s>',
                               this.workerName, this.inputData);
    }

    parse() {
        this.workerName = this.msg[3].toString();
        this.inputData = this.msg.slice(4);
        this.input = JSON.parse(this.inputData, marshal.decode);

        this.method = this.input.method;
        if (this.method === undefined) {
            throw Error('Missing method property');
        }
    }

    reply(err, data) {
        if (this.replied) {
            return;
        }

        var data = this.formatReply(err, data);
        this.sendReply(data);
        this.replied = true;
    }

    formatReply(err, data) {
        var res;
        if (err) {
            res = {
                method: this.method,
                status: err
            };
        } else {
            res = {
                method: this.method,
                data: data
            };
        }

        return JSON.stringify(res, marshal.encode);
    }

    sendReply(data) {
        this.socket.send([this.id, '', MDP.C_CLIENT,
                          this.workerName, data]);
    }
}

class BrokerWorkerRequest extends BrokerRequest {

    parse() {
        this.wcmd = this.msg[3];
        this.id = this.id;

        if (this.msg[1].toString() !== '') {
            throw Error('Invalid onWorker message ' + this.msg);
        }

        if (this.wcmd == MDP.W_REPLY) {
            this.replyId = this.msg[4];
            this.replyData = this.msg[6].toString();
        }

    }

    toString() {
        var tail = this.msg.slice(4).map((el) => el.toString());
        return nefUtils.format('<workerReq id: %s, wcmd: %s, tail: [%s]>',
                               this.id.toString('hex'),
                               this.wcmd.toString('hex'),
                               tail.join(', '));
    }

    reply(err, data) {
        // We now don't have a way to respond to the worker
        // hence just trace them
        if (err) {
            debug.broker.workerReqErr(err.toString());
        }
    }

    sendReply(data) {
        throw Error('Workers protocol doesnt support any replies');
    }

}

function createBrokerRequest(socket, msg) {
    var cmd = msg[2].toString();

    if (cmd === MDP.W_WORKER) {
        return new BrokerWorkerRequest(socket, msg);
    } else if (cmd === MDP.C_CLIENT) {
        return new BrokerClientRequest(socket, msg);
    } else {
        console.error('Invalid broker request cmd: ' + cmd);
    }
}

module.exports = new Broker();
