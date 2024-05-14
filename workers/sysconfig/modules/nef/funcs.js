
'use strict';

const async = require('async');
const logger = require('nef/logger');
const fs = require('fs');
const url = require('url');
const os = require('os');

const execFile = require('child_process').execFile;
const NefError = require('nef/error').NefError;
const nefUtils = require('nef/utils');
const events = require('nef/events');
const augeas = require('nef/sysconfig/augeas.js');
const restConfig = nefUtils.requireConfig('config/rest');

const OPENSSL = '/usr/bin/openssl';
const CERT_SUBJ = '/CN=nef-cert/O=nef/C=US';
const CERT_DAYS = 720;

var Smf;
if (process.platform === 'sunos') {
    Smf = require('nef/sysconfig/smf').Smf;
}

var sshFmri = 'svc:/network/ssh:default';

augeas.loadLense('Sshd', '/etc/ssh/sshd_config');

events.declare('NEF_compound_attach', {
    description: 'Emitted when the node joins the federation',
    range: 'private',
    payload: {}
});

events.declare('NEF_compound_detach', {
    description: 'Emitted when the node leaves the federation',
    range: 'private',
    payload: {}
});

module.exports.readCertificateInfo = function(prop, ctx, done) {
    var res = {};
    var stop = false;

    async.series([
        // Firstly check that files are configured
        (next) => {
            async.forEach([
                'crt', 'key'
            ], (key, nextKey) => {
                if (!restConfig.certs || !restConfig.certs[key]) {
                    logger.warn(__('Certificate certs.%s isn\'t configured' ,
                                   key));
                    stop = true;
                }

                nextKey();
            }, next);
        },
        // Check certs are created
        (next) => {
            if (stop) {
                return next();
            }

            async.forEach([
                restConfig.certs.crt,
                restConfig.certs.key
            ], (file, nextFile) => {
                fs.exists(file, (exists) => {
                    if (!exists) {
                        logger.warn(__('Certificate %s missed' ,
                                        file));
                        stop = true;
                    }

                    nextFile();
                });
            }, next);
        },
        // Then read fingerprints
        (next) => {
            if (stop) {
                return next();
            }

            async.forEach(['sha256', 'sha512'], (method, nextSum) => {
                execFile(OPENSSL, [
                    'x509', '-noout', '-in', restConfig.certs.crt,
                    '-fingerprint', '-' + method
                ], (err, stdout, stderr) => {
                    if (err) {
                        return nextSum(err);
                    }
                    res[method] = stdout.split('=')[1].trim();
                    nextSum();
                });
            }, next);
        }
    ], (err) => {
        done(err, res);
    });
};

module.exports.setCertificate = function(prop, ctx, value, done) {
    if (value.generate) {
        generateCertificate(prop, ctx, value, done);
    } else if (value.publicKeyData && value.privateKeyData) {
        uploadCertificate(prop, ctx, value, done);
    } else {
        return done(NefError('EBADARG', 'Set value to {generate:true} ' +
                                        ' to generate new certificate'));
    }
};

function validatePrivateKey(keyFile, done) {
    execFile(OPENSSL, ['rsa', '-in', keyFile, '-check'],
        function(err, stdout, stderr) {
            if (err) {
                logger.error(__('Validation error: %s', err.toString()));
                return done(NefError(__('Private key is not valid. ' +
                        'Should pass \'openssl rsa -in FILE -check\'')));

            }
            done();
        });
};

function validatePublicCert(certFile, done) {
    execFile(OPENSSL, ['x509', '-in', certFile, '-text', '-noout'],
        function(err, stdout, stderr) {
            if (err) {
                logger.error(__('Validation error: %s', err.toString()));
                return done(NefError(__('Public key is not valid. ' +
                        'Should pass \'openssl x509 -in FILE -text -noout\'')));
            }
            done();
        });
};

function generateCertificate(prop, ctx, value, done) {
    var res = [];

    async.series([
        (next) => {
            execFile(OPENSSL, [
                'req', '-x509', '-newkey', 'rsa:2048',
                '-nodes', '-subj', CERT_SUBJ, '-days', CERT_DAYS,
                '-keyout', restConfig.certs.key,
                '-out', restConfig.certs.crt
            ], next);
        },
        (next) => updateCertificatePerms(restConfig.certs.key,
                                         restConfig.certs.crt,
                                         next),
        (next) => {
            module.exports.readCertificateInfo(prop, ctx, (err, data) => {
                if (err) {
                    return next(err);
                }

                res['value'] = data;
                next();
            });
        }
    ], (err) => {
        if (err) {
            logger.error(__('Failed to generate certificate: %s', err));
            return done(err);
        }

        done(undefined, res);
    });
};

function uploadCertificate(prop, ctx, value, done) {
    var res = [];

    var tmpKeyPath = restConfig.certs.key + '.in';
    var tmpCertPath = restConfig.certs.crt + '.in';
    async.series([
        (next) => fs.writeFile(tmpKeyPath, value.privateKeyData, next),
        (next) => fs.writeFile(tmpCertPath, value.publicKeyData, next),
        (next) => validatePrivateKey(tmpKeyPath, next),
        (next) => validatePublicCert(tmpCertPath, next),
        (next) => fs.writeFile(restConfig.certs.key,
                               value.privateKeyData, next),
        (next) => fs.writeFile(restConfig.certs.crt,
                               value.publicKeyData, next),
        (next) => updateCertificatePerms(restConfig.certs.key,
                                         restConfig.certs.crt,
                                         next),
        (next) => fs.unlink(tmpKeyPath, next),
        (next) => fs.unlink(tmpCertPath, next),
        (next) => {
            module.exports.readCertificateInfo(prop, ctx, (err, data) => {
                if (err) {
                    return next(err);
                }

                res['value'] = data;
                next();
            });
        },
    ], (err) => {
        if (err) {
            logger.error(__('Failed to generate certificate: %s', err));
            return done(err);
        }

        done(undefined, res);
    });
}

function updateCertificatePerms(privFile, publFile, done) {
    async.series([
        (next) => fs.chmod(privFile, 0o600, next),
        (next) => fs.chmod(publFile, 0o644, next)
    ], done);
};

module.exports.toggleFederation = function(prop, ctx, flag, done) {
    if (!flag) {
        events.privateEvent('NEF_compound_detach', {});
        return done();
    }

    // Validate properties
    var mod = prop.module;
    var allProps = nefUtils.arrayToDict(mod.properties, 'id');

    var compoundService = allProps['nef.federation.compound.service'].tValue;
    if (compoundService === '') {
        return done(NefError('EINVAL',
                __('Cannot enable federation without Compound service')));
    }

    events.privateEvent('NEF_compound_attach', {});
    done();
};

module.exports.setManagementAddress = function(value, done) {
    // Do not change ssh listening address in tests
    if (process.env.NEF_ENV === 'test') {
        return done();
    }

    // list of actions to be done
    async.parallel([
        rebindSshd.bind(this, value),
    ], done);
};

function rebindSshd(address, done) {
    if (process.platform === 'linux') {
        logger.warn('Restarting sshd is not supported on linux');
        return done();
    }

    async.series([

        // Check if address exists
        function(next) {
            if (!address || address === '0.0.0.0') {
                next();
                return;
            }
            var ifaces = os.networkInterfaces();
            for (var i in ifaces) {
                for (var j in ifaces[i]) {
                    if (ifaces[i][j].address === address) {
                        next();
                        return;
                    }
                }
            }
            next(NefError('EINVAL',
                __('Can\'t set non-existing management address')));
        },

        // Update ssh config
        function(next) {
            augeas.write(function(aug, cb) {
                aug.set('/files/etc/ssh/sshd_config/ListenAddress', address);
                cb();
            }, next);
        },

        // Restart sshd
        function(next) {
            // Restart smf service for ssh worker
            var smf = new Smf(sshFmri);
            smf.svcadm('disable', function(err) {
                if (!err) {
                    smf.svcadm('enable', function(err) {
                        if (err) {
                            logger.warn(err);
                        } else {
                            logger.debug(
                                    __('SSH service successfully restarted'));
                        }
                        done();
                    });
                } else {
                    logger.warn(err);
                    done(err);
                }
            });
        }
    ], done);
}

module.exports.setProxy = function(ctx, value, done) {
    if (value === null) {
        return done();
    }

    var u = url.parse(value);

    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        done(new NefError('EBADARG',
                __('Proxy protocol must be http or https')));
        return;
    }
    if (u.auth && u.auth.indexOf(':') !== -1 &&
        ['set', 'bulkSet'].indexOf(ctx.type) !== -1) {
        done(new NefError('EBADARG',
                __('Use dedicated config setting for proxy password')));
        return;
    }
    if (u.hash || u.query) {
        done(new NefError('EBADARG',
                __('Proxy URL cannot contain query and hash string')));
        return;
    }
    if (!u.host) {
        done(new NefError('EBADARG',
                __('Missing host specification in proxy URL')));
        return;
    }

    done(undefined, {
        value: url.format(u)
    });
};

/* function gets proxy url as argument
 *
 * @param  {String}  value          - url to be splitted
 * @return {Object}  res            - object with two params
 * @return {String}  res.url        - url without password
 * @return {String} [res.password]  - password from that url
 */
module.exports.extractProxyPass = function(value) {
    var res = {
        url: value,
        password: undefined
    };

    if (!value || typeof(value) !== 'string') {
        return res;
    }

    var u = url.parse(value);
    if (!u.auth || u.auth.indexOf(':') === -1) {
        return res;
    }

    res.password = u.auth.split(':')[1];
    u.auth = u.auth.split(':')[0];
    res.url = url.format(u);
    return res;
};

/*
 * Work around CLI not being able to parse arguments beginning with "--".
 * We allow spaces at the beginning and trim them here.
 *
 * TODO: would be nice to utilize x509 module to validate certificates before
 * they are set
 */
module.exports.setCertAuthorities = function(value, done) {
    if (value) {
        value = value.map(ent => ent.trim());
    }

    done(undefined, {value});
};

module.exports.validateEsdbServers = function(value, done) {
    for (let s of value) {
        const {url: u, password, username} = s;

        if (u) {
            var parsed = url.parse(u);
            const {port} = parsed;

            if (!port || port < 0 || port > 65535) {
                return done(NefError('EINVAL',
                            __('Insufficient ESDB port number: %s', port)));
            }
        }

        if (password != null && username == null) {
            return done(NefError('EINVAL',
                __('Username must be specified when specifying ' +
                   'ESDB password')));
        }
    }
    done();
};
