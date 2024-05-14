var fs = require('fs');
var path = require('path');
var logger = require('nef/logger');
var current = {};

exports.register = function(dir, callback) {
    dir = path.resolve(dir);
    if (!current[dir]) {
        logger.info(__('Create watcher for dir: %s', dir));
        current[dir] = fs.watch(dir);
        current[dir].setMaxListeners(0);
    }

    var localCallback = function(event, filename) {
        if (filename === null) {
            // According to the oficial Node spec: "Providing filename argument
            // in the callback is not supported on every platform. (currently
            // it's only supported on Linux and Windows)".
            // On Solaris it's not supported, so it's expected behavior.
            return;
        }
        callback(event, filename);
    };

    current[dir].on('change', localCallback);

    return {
        dir: dir,
        callback: localCallback,
    };
};

exports.unregister = function(id) {
    logger.info('Remove watcher on dir', id.dir);
    current[id.dir].removeListener('change', id.callback);

    if (current[id.dir].listeners('change').length === 0) {
        logger.info('Removing empty listener on', id.dir);
        current[id.dir].close();
        delete current[id.dir];
    }
};

exports.current = current;
