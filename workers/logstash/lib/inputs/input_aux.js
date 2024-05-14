/**
 * Auxilary input handler for Logstash worker.
 *
 * Copyright (C) 2017  Nexenta Systems, Inc.
 * All rights reserved.
 */

var baseInput = require('../lib/base_input');
var util = require('util');

function InputAux() {
    baseInput.BaseInput.call(this);
    this.mergeConfig(this['unserializer_config']());
    this.mergeConfig({
        'name': 'Aux',
        'optional_params': [],
        'start_hook': this.start
    });
    this.config['optional_params'] = [];
};

util.inherits(InputAux, baseInput.BaseInput);

InputAux.prototype.close = function(callback) {
    callback();
};

InputAux.prototype.start = function(callback) {
    callback();
};

InputAux.prototype.inject = function(message) {
    this.emit('data', {
        message: message
    });
};

var auxInstance;

exports.create = function() {
    if (!auxInstance) {
        auxInstance = new InputAux();
    }
    return auxInstance;
};

exports.getInstance = function() {
    return auxInstance;
};
