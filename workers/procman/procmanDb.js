/*
 * Object database used by procman to store information about workers.
 */

'use strict';

var async = require('async');

var ObjectDb = require('nef/objectDb');
var logger = require('nef/logger');
var worker = require('nef/baseWorker');

var schemas  = require('./procmanSchemas');

var db = new ObjectDb(worker.dbDir, 'inmemory', {
    'workers': {
        autoCommit: true,
        primaryKey: 'id',
        objectSchema: schemas.workerStoredData,
        upgradePaths: {
            1: function(wrk) {
                if (!wrk.hasOwnProperty('heartbeatDisabled')) {
                    wrk.heartbeatDisabled = false;
                }
                return wrk;
            },
            2: function(wrk) {
                // Use new unique id key instaed of name
                // so workers in dev paths and system paths
                // won't collide
                if (!wrk.hasOwnProperty('id')) {
                    wrk.id = `${wrk.name}:${wrk.path}`;
                }

                // Remove props that don't change
                // and not needed here
                for (var prop of ['args', 'depends', 'registeredExplicitly']) {
                    if (wrk.hasOwnProperty(prop)) {
                        delete wrk[prop];
                    }
                }
                return wrk;
            }
        }
    }
});

function init(reset, done) {
    db.open({
        trunc: reset,
        createDir: true
    }, done);
}

function fini(done) {
    db.close(done);
}

class StoredWorkerData {
    constructor(worker) {
        this.worker = worker;
    }

    get id() {
        return `${this.worker.name}:${this.worker.path}`;
    }

    load(done) {
        this.data = undefined;

        async.series([
            (next) => {
                // Try load existing data
                try {
                    this.data = db.workers.loadObject(this.id);
                } catch (err) {
                    if (err && err.code !== 'ENOENT') {
                        return next(err);
                    }
                }
                return next();
            },
            (next) => {
                // Create if nothing found
                if (this.data !== undefined) {
                    return next();
                }

                this.data = {
                    id: this.id,
                    name: this.worker.name,
                    path: this.worker.path
                };

                logger.debug(__('New worker %s',
                                this.worker.name));
                db.workers.createObject(this.data, next);
            }
        ], done);
    }

    update(changes, done) {
        db.workers.updateObject(this.id, {
            $set: changes
        }, (err) => {
            if (err) {
                return done(err);
            }
            try {
                this.data = db.workers.loadObject(this.id);
            } catch (err) {
                return done(err);
            }
            done();
        });
    }
};

module.exports.init = init;
module.exports.fini = fini;
module.exports.StoredWorkerData = StoredWorkerData;
