#!/usr/bin/env node

/**
 * @FileOverview Logstash worker
 * Copyright (C) 2014  Nexenta Systems, Inc.
 * All rights reserved.
 */

var worker = require('nef/fedWorker');
var logstashMain = require('./logstashMain.js');
var logger = require('nef/logger');

worker.info(require('./worker.json'));

logstashMain.initialize(worker, function() {
    worker.start();
});
