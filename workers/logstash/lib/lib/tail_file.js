var fs = require('fs'),
  path = require('path'),
  util = require('util'),
  events = require('events'),
  directory_watcher = require('./directory_watcher'),
  spawn = require('child_process').spawn,
  tail = require('tail'),
  logger = require('nef/logger');

function Tailer(filename, options) {
  this.filename = path.resolve(filename);
  this.options = options;
}

util.inherits(Tailer, events.EventEmitter);

function split_buffer(buffer, callback) {
  var data = buffer.toString();
  while (true) {
    var index = data.indexOf('\n');
    if (index === -1) {
      // No line break, the whole line should be consumed.
      callback(data);
      break;
    }
    if (index > 0) {
      callback(data.slice(0, index));
    }
    data = data.slice(index + 1);
  }
}

Tailer.prototype.tail = function() {
  var self = this;
  logger.debug(__('Launching tail on %s', self.filename));
  self.tailer = new tail.Tail(self.filename);

  self.tailer.on('line', function(data) {
    split_buffer(data, function(line) {
      self.emit('data', line);
    });
  });
  this.tailer.on('error', function(error) {
    logger.error(error.toString());
  });
};

Tailer.prototype.start = function(callback, start_index) {
  fs.exists(this.filename, function(exists) {
    if (exists) {
      this.tail();
      // give time for tail start
      setTimeout(callback, 200);
    }
    else {
      try {
        this.dir = path.dirname(this.filename);
        var basename = path.basename(this.filename);
        logger.info('Watching dir', this.dir, 'for file', basename);
        this.dir_watcher = directory_watcher.register(this.dir, function(event, filename) {
          if (event === 'change' && basename === filename && !this.tailer) {
            this.tail(2000);
          }
        }.bind(this));
        callback();
      }
      catch (err) {
        logger.error('Unable to monitor dir', this.dir, err);
        callback(err);
      }
    }
  }.bind(this));
};

Tailer.prototype.close = function(callback) {
  if (this.tailer) {
    delete this.tailer;
  }
  if (this.dir_watcher) {
    logger.debug('Closing directory monitoring for', this.dir);
    directory_watcher.unregister(this.dir_watcher);
    delete this.dir_watcher;
  }
  callback();
};

exports.tail = function(filename, options) {
  return new Tailer(filename, options || {});
};
