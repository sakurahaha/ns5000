'use strict'

var NefError = require('nef/error').NefError;
var workerRep = require('./workerRep');

var api = {};

// WARNING 1: do not use helpers, big libs or so on
// It should be as simple as possible!

// WARNING 2: Broker should not be ever called directly
// or subscribed directly from any worker
// except procman !!!  It's needed to be able replace
// broker with something more solid in future.

// In all API calls this = broker itself

api.getTime = function(args, done) {
    done(undefined, (new Date()).toISOString());
};

api.getWorkers = function(args, done) {
    done(undefined, this.workers.names);
};

api.getStats = function(args, done) {
    var res = this.workers.all.map((worker) => {
        return {
            name: worker.name,
            connected: worker.connected,
            liveness: worker.liveness,
            stats: worker.stats
        };
    });
    done(undefined, res);
};

api.getProto = function(args, done) {
    done(undefined, {
        desc: {
            name: 'broker',
            description: 'Broker process',
            pid: process.pid
        },

        methods: {},
        events: {}
    });
};

api.updateWorkers = function(args, done) {
    for (var data of args.workers || []) {
        var worker = this.workers.find(data.name);
        if (!worker) {
            worker = new workerRep.WorkerRep(data.name);
            this.workers.add(worker);
            this.subscribeToWorker(worker);
        }

        worker.updateData(data);
    }

    done();
};

api.ping = function(args, done) {
    done(undefined, args.msg || 'pong');
};

module.exports.handleCall = function(input, done) {
    if (api[input.method] === undefined) {
        return done(NefError('ENOSYS',
                 __('Unknown method: %s', input.method)));
    }

    api[input.method].bind(this)(input.args || {}, done);
};
