var d;
try {
    d = require('dtrace-provider');
} catch (err) {
    if (err.code != 'MODULE_NOT_FOUND') {
        throw err;
    }
}

function BrokerDTP() {
    if (!d) return this;

    var self = this;

    self.dtp = d.createDTraceProvider('nefbroker', 'NEF');

    // probe arguments: worker name, payload
    self.dtp.addProbe('request', 'char *', 'char *');
    self.dtp.addProbe('reply', 'char *', 'char *');
    self.dtp.enable();
}

BrokerDTP.prototype.request = function (worker, msg) {
    if (!d) return this;

    this.dtp.fire('request', function () {
        msg = payloadToString(msg);
        return [worker, msg];
    });
};

BrokerDTP.prototype.reply = function (worker, msg) {
    if (!d) return this;

    this.dtp.fire('reply', function () {
        msg = payloadToString(msg);
        return [worker, msg];
    });
};

function payloadToString(msg) {
    if (typeof msg !== 'string') {
        msg = msg.reduce(function (acc, buf) {
                return acc + buf.toString();
        }, '');
    }
    return msg;
}

exports = module.exports = BrokerDTP;
