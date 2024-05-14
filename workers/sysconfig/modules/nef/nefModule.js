const funcs = require('./funcs.js');
const augeas = require('nef/sysconfig/augeas.js');
const Module = require('nef/sysconfig/module.js');
const schemaUtils = require('nef/schemaUtils');
const nodeSchema = require('nef/schemas/node');
const async = require('async');
const util = require('util');
const logger = require('nef/logger');
const nefUtils = require('nef/utils');

var config = {
    name: 'nef',
    description: __('Basic NEF settings'),
    version: 3,
    publicNamePrefix: 'system.',
    properties: [
        {
            'name': 'managementAddress',
            'publicName': true,
            'description': __('Management IP address'),
            'persistentSetter': funcs.setManagementAddress,
            'schema': schemaUtils.common.ipvX,
            'default': '0.0.0.0',
            'ignoreContexts': ['clone'],
        },
        {
            'name': 'Uuid',
            'description': __('System UUID'),
            'ignoreContexts': ['clone'],
        },
        {
            'name': 'managerUuid',
            'description': __('Manager host UUID'),
            'ignoreContexts': ['clone'],
        },
        {
            'name': 'analyticsIp',
            'description': __('Analytics Pub socket IP address'),
            'ignoreContexts': ['clone'],
        },
        {
            'name': 'administratorEmail',
            'publicName': true,
            'description': __('Email address for maintenance letters'),
            'schema': schemaUtils.common.email
        },
        {
            'name': 'webProxy',
            'publicName': true,
            'description': __('URL specifying HTTP(s) proxy location'),
            'type': 'string',
            'setter': funcs.setProxy
        },
        {
            'name': 'webProxyPassword',
            'publicName': true,
            'description': __('Password for HTTP(s) proxy ' +
                    '(user name is part of proxy URL)'),
            'type': 'string',
            'protected': true
        },
        {
            'name': 'certAuthorities',
            'publicName': true,
            'allowedZones': ['global'],
            'description': __('PEM certificates of additional authorities ' +
                    'used for validation of peer\'s certificate'),
            'default': [],
            'schema': {
                type: 'array',
                items: {
                    description: 'PEM encoded certificate',
                    type: 'string'
                }
            },
            'setter': funcs.setCertAuthorities
        },
        {
            'name': 'security.httpsCertificate',
            'publicName': '.rest.certificate',
            'description': __('HTTPS certificate used by REST and' +
                              ' other SSL services'),
            'schema': {
                type: 'object',
                properties: {
                    sha256: {
                        type: 'string',
                        description: 'SHA256 for the current certificate',
                    },
                    sha512: {
                        type: 'string',
                        description: 'SHA512 for the current certificate',
                    },
                    generate: {
                        type: 'boolean',
                        description: 'set to true to generate new certificate',
                    },
                    publicKeyData: {
                        type: 'string',
                        description: 'public key data to set'
                    },
                    privateKeyData: {
                        type: 'string',
                        description: 'private key data to set'
                    },
                }
            },
            'default': {},
            'getter': funcs.readCertificateInfo,
            'setter': funcs.setCertificate,
            'noExport': false
        },
        {
            'name': 'locationInfo',
            'description': __('Location information'),
            'type': 'object',
            'default': {},
            'ignoreContexts': ['clone'],
        },
        /*
         * Federation-related parameters.
         */
        {
            'name': 'federation.enabled',
            'description': __('Enable/disable node federation membership'),
            'type': 'boolean',
            'setter': funcs.toggleFederation,
            'default': false,
        },
        {
            'name': 'federation.elasticSearch.servers',
            'description': __('ElasticSearch servers information'),
            'default': [],
            'schema': nodeSchema.elasticSearchServers,
            'validator': funcs.validateEsdbServers
        },
        {
            'name': 'federation.security.allowSelfSignedCerts',
            'description': __('Allow self-signed SSL certificates'),
            'type': 'boolean',
            'default': true
        },
        {
            'name': 'federation.compound.apiKey',
            'description': __('API key for accessing Compound API'),
            'type': 'string',
            'default': ''
        },
        {
            'name': 'federation.compound.service',
            'description': __('Compound service configuration'),
            'schema': {
                'oneOf': [
                    {
                        type: 'object',
                        additionalProperties: false
                    },
                    schemaUtils.common.hostPort,
                    {
                        type: 'string'
                    }
                ]
            },
            'default': {},
        },
    ],
    migrations: {
        from1to2: function(task, props, done) {
            // Extract password from webProxy to
            // separate webProxyPassword
            if (!props.webProxy) {
                return done(undefined, props);
            }

            res = funcs.extractProxyPass(props.webProxy);
            if (res.password === undefined) {
                // no password found
                return done(undefined, props);
            }

            if (typeof(props.webProxyPassword) === 'string' &&
                props.webProxyPassword !== '' &&
                props.webProxyPassword !== res.password) {
                logger.warn(__('Can\'t extract password from webProxy: ' +
                           'there is already something in webProxyPassword'));
                return done(undefined, props);
            }

            props.webProxy = res.url;
            props.webProxyPassword = res.password;
            done(undefined, props);
        },
        from2to3: function(task, props, done) {
            done(undefined, props);
        }
    }
};

module.exports.init = function init(worker, callback) {
    callback(undefined, new Module({
        worker: worker,
        config: config
    }));
};
