'use strict';

const async = require('async');
const logger = require('nef/logger');
const sslUtils = require('nef/sslUtils');

module.exports.getCertAuthorities = function(done) {
    sslUtils.listCas(function(err, cas) {
        if (err) {
            return done(err);
        }
        var result = [];
        for (var ca of cas) {
            result.push(ca.name);
        }
        done(undefined, result);
    });
};

module.exports.getRequests = function(done) {
    sslUtils.listRequests(function(err, requests) {
        if (err) {
            return done(err);
        }
        var result = [];
        for (var req of requests) {
            result.push(req.name);
        }
        done(undefined, result);
    });
};

module.exports.getCertificates = function(done) {
    sslUtils.listCertificates(function(err, certificates) {
        if (err) {
            return done(err);
        }
        var result = [];
        for (var cert of certificates) {
            result.push(cert.name);
        }
        done(undefined, result);
    });
};

