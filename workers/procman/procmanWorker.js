/**
 * @fileOverview Main procman file, that should merge all other parts
 */

'use strict';

const logger = require('nef/logger');
logger.logToStdout = function() {
    const loggerWorker = procman.workers.get('logger');
    return !(loggerWorker && loggerWorker.status === 'online');
};

const worker = require('nef/baseWorker');
worker.info(require('./worker.json'));

const Procman = require('./lib/Procman');
const procman = worker.procman = new Procman();

require('./procmanApi');

module.exports.procman = procman;
