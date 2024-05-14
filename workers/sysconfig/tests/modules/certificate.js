/*
 * Sysconfig certificate API BDD tests.
 *
 * Copyright (C) 2019 Nexenta Systems, Inc
 * All rights reserved.
 *
 */

const fs = require('fs');
const async = require('async');
const exec = require('child_process').execFile;
const testHelpers = require('nef/testHelpers');
const nefUtils = require('nef/utils');
const sslUtils = require('nef/sslUtils');
const interop = require('nef/interop');

const chai = require('chai');
const expect = chai.expect;
const assert = chai.assert;

const OPENSSL = '/usr/bin/openssl';
const testPath = process.env.NEF_CORE_ROOT +
                 '/workers/sysconfig/tests/sslObjects';
const basePath = sslUtils.SSL_PATH;
const casPath = sslUtils.SSL_CAS_PATH;
const certificatesPath = sslUtils.SSL_CERTIFICATES_PATH;
const keysPath = sslUtils.SSL_KEYS_PATH;
const requestsPath = sslUtils.SSL_REQUESTS_PATH;
const optionsPath = sslUtils.SSL_OPTIONS_PATH;
const validCaPath = casPath + '/validCa.pem';
const validCaCrtPath = casPath + '/validCa.crt';
const testValidCaCrtPath = testPath + '/validCa.crt';
const validCaPemPath = testPath + '/validCa.pem';
const localCaPemSrc = testPath + '/LocalCA.pem';
const localCaSrlSrc = testPath + '/LocalCA.srl';
const localCaKeySrc = testPath + '/LocalCA.key';
const localCaPemTgt = casPath + '/LocalCA.pem';
const localCaSrlTgt = casPath + '/LocalCA.srl';
const localCaKeyTgt = keysPath + '/LocalCA.key';
const invalidCaPath = casPath + '/invalidCa.pem';
const invalidCaPemPath = testPath + '/invalidCa.pem';
const testSubject = '/C=US/ST=CA/L=SC/O=Nexenta/OU=NEF/CN=TestCrt';
const testSslCertCsrPath = requestsPath + '/testSslCert.csr';
const testSslCertKeyPath = keysPath + '/testSslCert.key';
const passphrasePath = '/test/pp';
const testSslCertCrtPath = certificatesPath + '/testSslCert.crt';
const testSslCertPemPath = testPath + '/testSslCert.pem';
const invalidSslCertPemPath = requestsPath + '/testSslCert.pem';
const testCrtPath = testPath + '/testSslCert.crt';
const testWrongCaCrtPath = testPath + '/testSslCertWrongCA.crt';
const days = 365;
const testAltName = 'dns:test1.example.com,dns:test2.example.com,' +
                    'ip:192.168.1.51,ip:192.168.1.52';
const testAltNameUpdated = testAltName + ',ip:192.168.1.53';
const testAltNameSub = 'dns:test1.example.com,ip:192.168.1.51';
const testAllDnsPattern = '%ALL_DNS%';
const testAllIpsPattern = '%ALL_IPS%';
const testAllPattern = '%ALL%';
const resultAltName = 'DNS:test1.example.com, DNS:test2.example.com, ' +
                      'IP Address:192.168.1.51, IP Address:192.168.1.52';
const workerCrtSrc = testPath + '/test.worker.crt';
const workerKeySrc = testPath + '/test.worker.key';
const workerOptAllSrc = testPath + '/test.worker.all.opt';
const workerOptAllIpsSrc = testPath + '/test.worker.all.ips.opt';
const workerOptAllDnsSrc = testPath + '/test.worker.all.dns.opt';
const workerCrtTgt = certificatesPath + '/test.worker.crt';
const workerKeyTgt = keysPath + '/test.worker.key';
const workerOptTgt = optionsPath + '/test.worker';
const NefCaPem = casPath + '/NefCA.pem';
const testDomainName = 'test.example.com';

function destroySslObject(path, done) {
    fs.stat(path, function(err) {
        if (err) {
            done();
            return;
        }
        fs.unlink(path, done);
    });
}

function installLocalCa(done) {
    async.parallel([
        (next) => fs.copyFile(localCaPemSrc, localCaPemTgt, next),
        (next) => fs.copyFile(localCaSrlSrc, localCaSrlTgt, next),
        (next) => fs.copyFile(localCaKeySrc, localCaKeyTgt, next),
    ], done);
}

function installWorkerCert(done) {
    async.parallel([
        (next) => fs.copyFile(workerCrtSrc, workerCrtTgt, next),
        (next) => fs.copyFile(workerKeySrc, workerKeyTgt, next),
    ], done);
}

function installCa(done) {
    fs.copyFile(validCaPemPath, validCaPath, done);
}

function installCsr(done) {
    fs.copyFile(testPath + '/testSslCert.csr', testSslCertCsrPath, done);
}

function installKey(done) {
    fs.copyFile(testPath + '/testSslCert.key', testSslCertKeyPath, done);
}

function clear(done) {
    async.parallel([
        (next) => destroySslObject(validCaPath, next),
        (next) => destroySslObject(validCaCrtPath, next),
        (next) => destroySslObject(invalidCaPath, next),
        (next) => destroySslObject(testSslCertCsrPath, next),
        (next) => destroySslObject(testSslCertKeyPath, next),
        (next) => destroySslObject(testSslCertCrtPath, next),
        (next) => destroySslObject(invalidSslCertPemPath, next),
        (next) => destroySslObject(localCaPemTgt, next),
        (next) => destroySslObject(localCaSrlTgt, next),
        (next) => destroySslObject(localCaKeyTgt, next),
        (next) => destroySslObject(workerCrtTgt, next),
        (next) => destroySslObject(workerKeyTgt, next),
        (next) => destroySslObject(workerOptTgt, next),
    ], done);
}

module.exports = function() {
    var self = this;
    var validCa;
    var invalidCa;
    var testWorkerCertificatePem;

    before(function(done) {
        async.parallel([
            (next) => fs.readFile(validCaPemPath, (err, data) => {
                if (err) {
                    next(err);
                    return;
                }

                validCa = data.toString();
                next();
            }),
            (next) => fs.readFile(invalidCaPemPath, (err, data) => {
                if (err) {
                    next(err);
                    return;
                }

                invalidCa = data.toString();
                next();
            }),
            (next) => fs.readFile(workerCrtSrc, (err, data) => {
                if (err) {
                    next(err);
                    return;
                }

                testWorkerCertificatePem = data.toString();
                next();
            }),
        ], done);
    });

    beforeEach(clear);
    after(clear);

    /*
     * Certificate Authority tests
     */
    it('should install CA', function(done) {
        // CA file should pass verification

        async.series([
            (next) => {
                self.worker.installSslCertificateAuthority({
                    name: 'validCa',
                    pemContents: validCa
                }, next);
            },

            // should create CA file
            (next) => {
                fs.stat(validCaPath, function(err) {
                    assert.ifError(err);

                    next();
                });
            },

        ], done);
    });

    it('should list the installed CA by name', function(done) {
        // list CA name
        // list CA in PEM
        // list CA file path
        async.series([
            (next) => {
                self.worker.installSslCertificateAuthority({
                    name: 'validCa',
                    pemContents: validCa
                }, next);
            },

            (next) => {
                self.worker.findCertificateAuthorities({
                    where: {
                        name: 'validCa'
                    }
                }, function(err, data) {
                    assert.ifError(err);

                    assert(data.length == 1, 'should find installed ' +
                        'certificate authorities');
                    assert(data[0].name == 'validCa', 'should list ' +
                        'certificate authority name');
                    assert(data[0].pemContents, 'should list CA contents');
                    assert(data[0].path == validCaPath, 'should list a ' +
                        'correct path for Certificate authority');

                    next();
                });
            }
        ], done);
    });

    it('should not list files with extensions other than *.pem as CAs',
        function(done) {

        var casBefore;
        var casAfter;

        async.series([
            (next) => {
                self.worker.findCertificateAuthorities({}, function(err, data) {
                    assert.ifError(err);

                    casBefore = data.length;
                    next();
                });
            },
            (next) => {
                fs.copyFile(testValidCaCrtPath, validCaCrtPath, next);
            },

            (next) => {
                self.worker.findCertificateAuthorities({}, function(err, data) {
                    assert.ifError(err);

                    casAfter = data.length;
                    assert(casBefore == casAfter);
                    next();
                });
            },

        ], done);
    });

    it('should not install CA with the name that already exists',
        function(done) {
        async.series([
            (next) => {
                self.worker.installSslCertificateAuthority({
                    name: 'validCa',
                    pemContents: validCa
                }, next);
            },

            (next) => {
                self.worker.installSslCertificateAuthority({
                    name: 'validCa',
                    pemContents: validCa
                }, function(err) {
                    expect(err).to.have.errorCode('EEXIST');
                    next();
                });
            },
        ], done);
    });

    it('should not install CA that is not in PEM format (or format is invalid)',
        function(done) {
        self.worker.installSslCertificateAuthority({
            name: 'invalidCa',
            pemContents: invalidCa
        }, function(err) {
            expect(err).to.have.errorCode('EINVAL');
            done();
        });
    });

    it('should destroy CA by name', function(done) {
        // CA file should be destroyed
        async.series([
            (next) => {
                self.worker.installSslCertificateAuthority({
                    name: 'validCa',
                    pemContents: validCa
                }, next);
            },

            (next) => self.worker.destroySslCertificateAuthority({
                name: 'validCa'
            }, next),

            (next) => self.worker.findCertificateAuthorities({
                where: {
                    name: 'validCa'
                }
            }, function(err, data) {
                assert.ifError(err);

                assert(data.length == 0, 'Should not list destroyed CA');
                next();
            })
        ], done);
    });

    /*
     * Certificate signing request generation
     */
    it('should generate Certificate Signing requests', function(done) {
        async.series([
            (next) => {
                self.worker.generateSslSigningRequest({
                    name: 'testSslCert',
                    subject: testSubject,
                    passphrase: 'nexenta'
                }, next);
            },

            // should create *.key file
            (next) => {
                fs.stat(testSslCertKeyPath, function(err) {
                    assert.ifError(err);

                    next();
                });
            },

            // should create *.csr file
            (next) => {
                fs.stat(testSslCertCsrPath, function(err) {
                    assert.ifError(err);

                    next();
                });
            },

            // should delete passphrase file after successful creation
            (next) => {
                fs.stat(passphrasePath, function(err) {
                    if (err) {
                        next();
                        return;
                    }

                    assert.ifError('Passphrase file was not destroyed');
                    next();
                });
            },
        ], done);
    });

    it('should list generated Certificate Signing requests by name',
        function(done) {
        // list CSR name
        // list CSR in PEM
        // list CSR file path
        async.series([
            (next) => {
                self.worker.generateSslSigningRequest({
                    name: 'testSslCert',
                    subject: testSubject,
                    passphrase: 'nexenta'
                }, next);
            },

            (next) => {
                self.worker.findRequests({
                    where: {
                        name: 'testSslCert'
                    }
                }, function(err, data) {
                    assert.ifError(err);

                    assert(data.length == 1, 'should find generated ' +
                        'certificate signing requests');
                    assert(data[0].name == 'testSslCert', 'should list ' +
                        'certificate signing request name');
                    assert(data[0].pemContents, 'should list request contents');
                    assert(data[0].path == testSslCertCsrPath, 'should list ' +
                        'a correct path for certificate signing request');

                    next();
                });
            }
        ], done);
    });

    it('should not list files with extensions other than *.csr as ' +
        'Certificate Signing Requests', function(done) {

        var requestsBefore;
        var requestsAfter;

        async.series([
            (next) => {
                self.worker.findRequests({}, function(err, data) {
                    assert.ifError(err);

                    requestsBefore = data.length;
                    next();
                });
            },

            (next) => {
                fs.copyFile(testSslCertPemPath, invalidSslCertPemPath, next);
            },

            (next) => {
                self.worker.findRequests({}, function(err, data) {
                    assert.ifError(err);

                    requestsAfter = data.length;
                    assert(requestsBefore == requestsAfter);
                    next();
                });
            },

        ], done);
    });

    it('should not generate Certificate Signing request in case a request ' +
        'with same name exists', function(done) {
        async.series([
            (next) => {
                self.worker.generateSslSigningRequest({
                    name: 'testSslCert',
                    subject: testSubject,
                    passphrase: 'nexenta'
                }, next);
            },

            (next) => {
                self.worker.generateSslSigningRequest({
                    name: 'testSslCert',
                    subject: testSubject,
                    passphrase: 'nexenta'
                }, function(err) {
                    expect(err).to.have.errorCode('EEXIST');
                    next();
                });
            },
        ], done);
    });

    it('should delete a passphrase in case Certificate Signing request ' +
        'creation failed', function(done) {
        async.series([
            (next) => {
                self.worker.generateSslSigningRequest({
                    name: 'testSslCert',
                    subject: 'invalidSubjectText',
                    passphrase: 'nexenta'
                }, function(err) {
                    if (err) {
                        next();
                        return;
                    }

                    assert.ifError('Should fail to create signing request');
                    next();
                });
            },

            (next) => {
                fs.stat(passphrasePath, function(err) {
                    if (err) {
                        next();
                        return;
                    }

                    assert.ifError('passphrase file was not destroyed');
                    next();
                });
            }
        ], done);
    });

    it('should not list Certificate Signing requests that have no ' +
        'corresponding keys', function(done) {
        async.series([
            (next) => {
                self.worker.generateSslSigningRequest({
                    name: 'testSslCert',
                    subject: testSubject,
                    passphrase: 'nexenta'
                }, next);
            },

            (next) => fs.unlink(testSslCertKeyPath, next),

            (next) => {
                self.worker.findRequests({where: {name: 'testSslCert'}},
                    function(err, data) {
                    assert.ifError(err);

                    assert(data.length == 0, 'should not list requests ' +
                        'that have no corresponding key file');
                    next();
                });
            },
        ], done);
    });

    it('should destroy Certificate Signing request by name', function(done) {
        // CSR file should be destroyed
        // *.csr and *.key files has to be destroyed
        async.series([
            (next) => {
                self.worker.generateSslSigningRequest({
                    name: 'testSslCert',
                    subject: testSubject,
                    passphrase: 'nexenta'
                }, next);
            },

            (next) => self.worker.destroySslSigningRequest({
                name: 'testSslCert'
            }, next),

            (next) => self.worker.findRequests({
                where: {
                    name: 'testSslCert'
                }
            }, function(err, data) {
                assert.ifError(err);

                assert(data.length == 0, 'Should not list destroyed Signing ' +
                    'requests');
                next();
            })
        ], done);
    });

    it('should sign certificate in local CA', function(done) {
        async.series([
            // install local CA
            installLocalCa,

            // install CSR
            installCsr,

            // install Key
            installKey,

            // sign cert
            (next) => {
                self.worker.signSslSigningRequest({
                    name: 'testSslCert',
                    caName: 'LocalCA',
                    altName: testAltName,
                    days: days
                }, next);
            },

            // should create *.crt file
            (next) => {
                fs.stat(testSslCertCrtPath, function(err) {
                    assert.ifError(err);

                    next();
                });
            },

            // certificate should pass verification
            (next) => {
                exec(OPENSSL, ['verify', '-CAfile', localCaPemTgt,
                    testSslCertCrtPath], function(err) {
                    assert.ifError(err);

                    next();
                });
            },

            (next) => self.worker.findCertificates({
                where: {
                    name: 'testSslCert'
                }
            }, function(err, data) {
                assert.ifError(err);
                assert(data.length == 1, 'should find generated certificate');
                assert(data[0].name == 'testSslCert', 'should list ' +
                       'certificate name');
                assert(data[0].pemContents, 'should list certificate pem ' +
                       'contents');
                assert(data[0].altName == resultAltName, 'should list ' +
                       'certificate Subject Alternative Name');
                next();
            }),

        ], done);
    });

    /*
     * Installing certificates logic
     */
    it('should install signed certificate', function(done) {
        var signedCertificatePem;
        async.series([
            // install CA
            installCa,

            // install CSR
            installCsr,

            // install Key
            installKey,

            // read signed certificate PEM contents
            (next) => {
                fs.readFile(testCrtPath, function(err, data) {
                    assert.ifError(err);

                    signedCertificatePem = data.toString();
                    next();
                });
            },

            // install signed cert
            (next) => {
                self.worker.installSslSignedCertificate({
                    name: 'testSslCert',
                    caName: 'validCa',
                    certificatePem: signedCertificatePem,
                }, next);
            },

            // should create *.crt file
            (next) => {
                fs.stat(testSslCertCrtPath, function(err) {
                    assert.ifError(err);

                    next();
                });
            },

            // certificate should pass verification
            (next) => {
                exec(OPENSSL, ['verify', '-CAfile', validCaPath,
                    testSslCertCrtPath], function(err) {
                    assert.ifError(err);

                    next();
                });
            }
        ], done);
    });

    it('should not install signed certificate in case corresponding CSR ' +
        'does not exist', function(done) {
        var signedCertificatePem;
        async.series([
            // install CA
            installCa,

            // install Key
            installKey,

            // read signed certificate PEM contents
            (next) => {
                fs.readFile(testCrtPath, function(err, data) {
                    assert.ifError(err);

                    signedCertificatePem = data.toString();
                    next();
                });
            },

            // install signed cert
            (next) => {
                self.worker.installSslSignedCertificate({
                    name: 'testSslCert',
                    caName: 'validCa',
                    certificatePem: signedCertificatePem,
                }, function(err) {
                    expect(err).to.have.errorCode('ENOENT');
                    next();
                });
            },
        ], done);
    });

    it('should not install signed certificate in case it does not pass ' +
        'validation across specified CA', function(done) {
        var signedCertificatePem;
        async.series([
            // install CA
            installCa,

            // install CSR
            installCsr,

            // install Key
            installKey,

            // read signed certificate PEM contents
            (next) => {
                fs.readFile(testWrongCaCrtPath, function(err, data) {
                    assert.ifError(err);

                    signedCertificatePem = data.toString();
                    next();
                });
            },

            // install signed cert
            (next) => {
                self.worker.installSslSignedCertificate({
                    name: 'testSslCert',
                    caName: 'validCa',
                    certificatePem: signedCertificatePem,
                }, function(err) {
                    expect(err).to.have.errorCode('EFAILED');
                    next();
                });
            },
        ], done);
    });

    it('should not install signed certificate in case specified CA does ' +
        'not exist', function(done) {
        var signedCertificatePem;
        async.series([
            // install CSR
            installCsr,

            // install Key
            installKey,

            // read signed certificate PEM contents
            (next) => {
                fs.readFile(testCrtPath, function(err, data) {
                    assert.ifError(err);

                    signedCertificatePem = data.toString();
                    next();
                });
            },

            // install signed cert
            (next) => {
                self.worker.installSslSignedCertificate({
                    name: 'testSslCert',
                    caName: 'nonExistingCa',
                    certificatePem: signedCertificatePem,
                }, function(err) {
                    expect(err).to.have.errorCode('ENOENT');
                    next();
                });
            },
        ], done);
    });

    it('should destroy certificate', function(done) {
        // should delete *.csr, *.key and *.crt files
        async.series([
            // install CA
            installCa,

            // install CSR
            installCsr,

            // install Key
            installKey,

            // read signed certificate PEM contents
            (next) => {
                fs.readFile(testCrtPath, function(err, data) {
                    assert.ifError(err);

                    signedCertificatePem = data.toString();
                    next();
                });
            },

            // install signed cert
            (next) => {
                self.worker.installSslSignedCertificate({
                    name: 'testSslCert',
                    caName: 'validCa',
                    certificatePem: signedCertificatePem,
                }, next);
            },

            (next) => self.worker.destroySslCertificate({
                name: 'testSslCert'
            }, next),

            (next) => self.worker.findRequests({
                where: {
                    name: 'testSslCert'
                }
            }, function(err, data) {
                assert.ifError(err);

                assert(data.length == 0, 'Should not list destroyed SSL ' +
                    'certificates');
                next();
            }),

            (next) => {
                fs.stat(testSslCertCsrPath, function(err) {
                    if (err) {
                        next();
                        return;
                    }

                    assert.ifError('CSR file was not destroyed');
                    next();
                });
            },

            (next) => {
                fs.stat(testSslCertKeyPath, function(err) {
                    if (err) {
                        next();
                        return;
                    }

                    assert.ifError('Key file was not destroyed');
                    next();
                });
            },

            (next) => {
                fs.stat(testSslCertCrtPath, function(err) {
                    if (err) {
                        next();
                        return;
                    }

                    assert.ifError('Certificate file was not destroyed');
                    next();
                });
            },
        ], done);
    });

    it('should create worker certificate', function(done) {
        async.series([

            (next) => self.worker.getOrCreateCertificate({
                    name: 'test.worker',
                    autogenerate: true
                }, function(err, data) {
                    assert.ifError(err);
                    assert(data.certificatePath === workerCrtTgt,
                           'should return certificatePath');
                    assert(data.privateKeyPath === workerKeyTgt,
                           'should return privateKeyPath');
                    next();
                }),

            // should create *.crt file
            (next) => {
                fs.stat(workerCrtTgt, function(err) {
                    assert.ifError(err);

                    next();
                });
            },

            // certificate should pass verification
            (next) => {
                exec(OPENSSL, ['verify', '-CAfile', NefCaPem,
                    workerCrtTgt], function(err) {
                    assert.ifError(err);

                    next();
                });
            },

            (next) => self.worker.findCertificates({
                where: {
                    name: 'test.worker'
                }
            }, function(err, data) {
                assert.ifError(err);
                assert(data.length == 1, 'should find generated certificate');
                assert(data[0].name == 'test.worker', 'should list ' +
                       'certificate name');
                assert(data[0].pemContents, 'should list certificate pem ' +
                       'contents');
                next();
            }),

        ], done);
    });

    it('should return file paths if worker certificate exists', function(done) {
        async.series([

            installWorkerCert,

            (next) => self.worker.getOrCreateCertificate({
                    name: 'test.worker',
                    autogenerate: false
                }, function(err, data) {
                    assert.ifError(err);
                    assert(data.certificatePath === workerCrtTgt,
                           'should return certificatePath');
                    assert(data.privateKeyPath === workerKeyTgt,
                           'should return privateKeyPath');
                    next();
                }),

            (next) => {
                fs.readFile(workerCrtTgt, function(err, data) {
                    assert.ifError(err);
                    assert(data.toString() === testWorkerCertificatePem,
                           'should not re-generate certificate');
                    next();
                });
            },

        ], done);
    });

    it('should re-generate worker certificate if subject updated',
       function(done) {
        async.series([

            installWorkerCert,

            (next) => self.worker.getOrCreateCertificate({
                    name: 'test.worker',
                    subject: '/C=US/ST=CA/L=SC/O=DDN/OU=NEF/CN=test.worker',
                    autogenerate: true
                }, function(err, data) {
                    assert.ifError(err);
                    assert(data.certificatePath === workerCrtTgt,
                           'should return certificatePath');
                    assert(data.privateKeyPath === workerKeyTgt,
                           'should return privateKeyPath');
                    next();
                }),

            (next) => {
                fs.readFile(workerCrtTgt, function(err, data) {
                    assert.ifError(err);
                    assert(data.toString() !== testWorkerCertificatePem,
                           'should re-generate certificate');
                    next();
                });
            },

        ], done);
    });

    it('should re-generate worker certificate if altName updated',
       function(done) {
        async.series([

            installWorkerCert,

            (next) => self.worker.getOrCreateCertificate({
                    name: 'test.worker',
                    altName: testAltNameUpdated,
                    autogenerate: true
                }, function(err, data) {
                    assert.ifError(err);
                    assert(data.certificatePath === workerCrtTgt,
                           'should return certificatePath');
                    assert(data.privateKeyPath === workerKeyTgt,
                           'should return privateKeyPath');
                    next();
                }),

            (next) => {
                fs.readFile(workerCrtTgt, function(err, data) {
                    assert.ifError(err);
                    assert(data.toString() !== testWorkerCertificatePem,
                           'should re-generate certificate');
                    next();
                });
            },

        ], done);
    });

    it('should not re-generate worker certificate if alt names are not ' +
       'less then given list', function(done) {
        async.series([

            installWorkerCert,

            (next) => self.worker.getOrCreateCertificate({
                    name: 'test.worker',
                    altName: testAltNameSub,
                    autogenerate: true
                }, function(err, data) {
                    assert.ifError(err);
                    assert(data.certificatePath === workerCrtTgt,
                           'should return certificatePath');
                    assert(data.privateKeyPath === workerKeyTgt,
                           'should return privateKeyPath');
                    next();
                }),

            (next) => {
                fs.readFile(workerCrtTgt, function(err, data) {
                    assert.ifError(err);
                    assert(data.toString() === testWorkerCertificatePem,
                           'should not re-generate certificate');
                    next();
                });
            },

        ], done);
    });

    it('should resolve %ALL_DNS% pattern for the worker certificate alt names',
       function(done) {
        if (process.platform === 'linux') {
            // Doesn't work on linux - no unix.hostDomainName prop
            this.skip();
        }

        if (process.env.NEF_ROOT === process.env.NEF_CORE_ROOT) {
            // Doesn't work without NEF - no unix.hostDomainName prop
            this.skip();
        }

        var hostDomainName;
        async.series([
            (next) => self.worker.getProperty({
                    id: 'unix.hostDomainName'
                }, function(err, res) {
                    hostDomainName = 'DNS:' + res;
                    assert.ifError(err);
                    next();
                }),

            (next) => self.worker.getOrCreateCertificate({
                    name: 'test.worker',
                    altName: testAllDnsPattern,
                    autogenerate: true
                }, function(err, data) {
                    assert.ifError(err);
                    assert(data.certificatePath === workerCrtTgt,
                           'should return certificatePath');
                    assert(data.privateKeyPath === workerKeyTgt,
                           'should return privateKeyPath');
                    next();
                }),

            (next) => self.worker.findCertificates({
                where: {
                    name: 'test.worker'
                }
            }, function(err, data) {
                assert.ifError(err);
                assert(data.length == 1, 'should find generated certificate');
                const cert = data[0];
                assert(cert.name == 'test.worker', 'should list ' +
                       'certificate name');
                assert(cert.pemContents, 'should list certificate pem ' +
                       'contents');
                assert(cert.altName == hostDomainName, 'should list ' +
                       'dns name');
                next();
            }),

        ], done);
    });

    it('should resolve %ALL_IPS% pattern for the worker certificate alt names',
       function(done) {
        if (process.platform === 'linux') {
            // Doesn't work on linux - no network worker
            this.skip();
        }

        if (process.env.NEF_ROOT === process.env.NEF_CORE_ROOT) {
            // Doesn't work without NEF - no network worker
            this.skip();
        }

        var hostIps;
        async.series([
            (next) => interop.call('network', 'findAddresses', {},
                                   function(err, res) {
                if (err) {
                    return next(err);
                }

                if (res && res.length) {
                    var result = [];
                    res.forEach(item => {
                        if (item.interface !== 'lo0' &&
                            item.protocol !== 'ipv6') {
                            result.push('IP Address:' + item.address);
                        }
                    });
                    hostIps = result.join(',');
                }

                next();
            }),

            (next) => self.worker.getOrCreateCertificate({
                    name: 'test.worker',
                    altName: testAllIpsPattern,
                    autogenerate: true
                }, function(err, data) {
                    assert.ifError(err);
                    assert(data.certificatePath === workerCrtTgt,
                           'should return certificatePath');
                    assert(data.privateKeyPath === workerKeyTgt,
                           'should return privateKeyPath');
                    next();
                }),

            (next) => self.worker.findCertificates({
                where: {
                    name: 'test.worker'
                }
            }, function(err, data) {
                assert.ifError(err);
                assert(data.length == 1, 'should find generated certificate');

                const cert = data[0];
                assert(cert.name == 'test.worker', 'should list ' +
                       'certificate name');
                assert(cert.pemContents, 'should list certificate pem ' +
                       'contents');
                assert(cert.altName, 'should list Subject Alternative Names');

                const a1 = cert.altName.replace(/\s/g, '').split(',');
                const a2 = hostIps.replace(/\s/g, '').split(',');

                assert(a1.sort().join() === a2.sort().join(),
                       'Subject Alternative Names should include host IPs');
                next();
            }),

        ], done);
    });

    it('should resolve %ALL% pattern for the worker certificate alt names',
       function(done) {
        if (process.platform === 'linux') {
            // Doesn't work on linux - no network worker
            // and unix.hostDomainName prop
            this.skip();
        }

        if (process.env.NEF_ROOT === process.env.NEF_CORE_ROOT) {
            // Doesn't work without NEF - no network worker
            // and unix.hostDomainName prop
            this.skip();
        }

        var hostDomainName;
        var hostIps;
        var altNamesStr;

        async.series([
            (next) => self.worker.getProperty({
                    id: 'unix.hostDomainName'
                }, function(err, res) {
                    hostDomainName = 'DNS:' + res;
                    assert.ifError(err);
                    next();
                }),

            (next) => interop.call('network', 'findAddresses', {},
                                   function(err, res) {
                if (err) {
                    return next(err);
                }

                if (res && res.length) {
                    var result = [];
                    res.forEach(item => {
                        if (item.interface !== 'lo0' &&
                            item.protocol !== 'ipv6') {
                            result.push('IP Address:' + item.address);
                        }
                    });
                    hostIps = result.join(',');
                }

                next();
            }),

            (next) => {
                const tmp = [];
                tmp.push(hostDomainName);
                tmp.push(hostIps);
                altNamesStr = tmp.join(',');
                next();
            },

            (next) => self.worker.getOrCreateCertificate({
                    name: 'test.worker',
                    altName: testAllPattern,
                    autogenerate: true
                }, function(err, data) {
                    assert.ifError(err);
                    assert(data.certificatePath === workerCrtTgt,
                           'should return certificatePath');
                    assert(data.privateKeyPath === workerKeyTgt,
                           'should return privateKeyPath');
                    next();
                }),

            (next) => self.worker.findCertificates({
                where: {
                    name: 'test.worker'
                }
            }, function(err, data) {
                assert.ifError(err);
                assert(data.length == 1, 'should find generated certificate');
                const cert = data[0];
                assert(cert.name == 'test.worker', 'should list ' +
                       'certificate name');
                assert(cert.pemContents, 'should list certificate pem ' +
                       'contents');
                assert(cert.altName, 'should list Subject Alternative Names');

                const a1 = cert.altName.replace(/\s/g, '').split(',');
                const a2 = altNamesStr.replace(/\s/g, '').split(',');

                assert(a1.sort().join() == a2.sort().join(),
                       'Subject Alternative Names should include host IPs ' +
                       'and DNS name');
                next();
            }),

        ], done);
    });

    it('should not re-generate certificates with %ALL_IPS% pattern on ' +
       'unix.domainName update',
       function(done) {
        if (process.platform === 'linux') {
            // Doesn't work on linux - no network worker
            // and unix.hostDomainName prop
            this.skip();
        }

        if (process.env.NEF_ROOT === process.env.NEF_CORE_ROOT) {
            // Doesn't work without NEF - no network worker
            // and unix.hostDomainName prop
            this.skip();
        }

        var origDomainName = null;

        async.series([

            installWorkerCert,

            (next) => fs.copyFile(workerOptAllIpsSrc, workerOptTgt, next),

            (next) => self.worker.getProperty({
                    id: 'unix.domainName'
                }, function(err, res) {
                    origDomainName = res;
                    next(err);
                }),

            (next) => testHelpers.waitEvent({
                event: 'NEF_sysconfig_patternsCertificatesUpdated',
                message: 'waiting for NEF_sysconfig_patternsCertificatesUpdated event',
                prepare: function(cb) {
                    self.worker.setProperty({
                        id: 'unix.domainName',
                        value: testDomainName,
                        persistent: true
                    }, function(err, res) {
                        assert.ifError(err);
                        cb(err);
                    });
                },
                done: next
            }),

            (next) => {
                fs.readFile(workerCrtTgt, function(err, data) {
                    assert.ifError(err);
                    assert(data.toString() === testWorkerCertificatePem,
                           'should not re-generate certificate');
                    next();
                });
            },

        ], function(err) {
            if (origDomainName) {
                self.worker.setProperty({
                    id: 'unix.domainName',
                    value: origDomainName,
                    persistent: true
                }, done);
                return;
            }
            done(err);
        });
    });

    it('should re-generate certificates with %ALL% pattern on ' +
       'unix.domainName update',
       function(done) {
        if (process.platform === 'linux') {
            // Doesn't work on linux - no network worker
            // and unix.hostDomainName prop
            this.skip();
        }

        if (process.env.NEF_ROOT === process.env.NEF_CORE_ROOT) {
            // Doesn't work without NEF - no network worker
            // and unix.hostDomainName prop
            this.skip();
        }

        var origDomainName = null;

        async.series([
            installWorkerCert,

            (next) => fs.copyFile(workerOptAllSrc, workerOptTgt, next),

            (next) => self.worker.getProperty({
                    id: 'unix.domainName'
                }, function(err, res) {
                    origDomainName = res;
                    next(err);
                }),

            (next) => testHelpers.waitEvent({
                event: 'NEF_sysconfig_patternsCertificatesUpdated',
                message: 'waiting for NEF_sysconfig_patternsCertificatesUpdated event',
                prepare: function(cb) {
                    self.worker.setProperty({
                        id: 'unix.domainName',
                        value: testDomainName,
                        persistent: true
                    }, function(err, res) {
                        assert.ifError(err);
                        cb(err);
                    });
                },
                done: next
            }),

            (next) => {
                fs.readFile(workerCrtTgt, function(err, data) {
                    assert.ifError(err);
                    assert(data.toString() !== testWorkerCertificatePem,
                           'should re-generate certificate');
                    next();
                });
            },

        ], function(err) {
            if (origDomainName) {
                self.worker.setProperty({
                    id: 'unix.domainName',
                    value: origDomainName,
                    persistent: true
                }, done);
                return;
            }
            done(err);
        });
    });

    it('should re-generate certificates with %ALL_DNS% pattern on ' +
       'unix.domainName update',
       function(done) {
        if (process.platform === 'linux') {
            // Doesn't work on linux - no network worker
            // and unix.hostDomainName prop
            this.skip();
        }

        if (process.env.NEF_ROOT === process.env.NEF_CORE_ROOT) {
            // Doesn't work without NEF - no network worker
            // and unix.hostDomainName prop
            this.skip();
        }

        var origDomainName = null;

        async.series([
            installWorkerCert,

            (next) => fs.copyFile(workerOptAllDnsSrc, workerOptTgt, next),

            (next) => self.worker.getProperty({
                    id: 'unix.domainName'
                }, function(err, res) {
                    origDomainName = res;
                    next(err);
                }),

            (next) => testHelpers.waitEvent({
                event: 'NEF_sysconfig_patternsCertificatesUpdated',
                message: 'waiting for NEF_sysconfig_patternsCertificatesUpdated event',
                prepare: function(cb) {
                    self.worker.setProperty({
                        id: 'unix.domainName',
                        value: testDomainName,
                        persistent: true
                    }, function(err, res) {
                        assert.ifError(err);
                        cb(err);
                    });
                },
                done: next
            }),

            (next) => {
                fs.readFile(workerCrtTgt, function(err, data) {
                    assert.ifError(err);
                    assert(data.toString() !== testWorkerCertificatePem,
                           'should re-generate certificate');
                    next();
                });
            },

        ], function(err) {
            if (origDomainName) {
                self.worker.setProperty({
                    id: 'unix.domainName',
                    value: origDomainName,
                    persistent: true
                }, done);
                return;
            }
            done(err);
        });
    });
};
