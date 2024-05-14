var Module = require('nef/sysconfig/module.js');
var compatibility = require('./compatibility.js');
var schemaUtils = require('nef/schemaUtils');

var config = {
    name: 'smtp',
    description: __('Outbound SMTP settings'),
    version: 2,
    properties: [
        {
            'name': 'host',
            'publicName': true,
            'description': __('SMTP server host name/IP address'),
            'schema': schemaUtils.common.host
        },
        {
            'name': 'port',
            'publicName': true,
            'description': __('SMTP port number (default 25)'),
            'default': 25,
            'schema': schemaUtils.common.port
        },
        {
            'name': 'senderEmail',
            'publicName': true,
            'description': __('Sender e-mail address'),
            'schema': schemaUtils.common.email
        },
        {
            'name': 'user',
            'publicName': true,
            'description': __('SMTP user name'),
            'type': 'string'
        },
        {
            'name': 'password',
            'publicName': true,
            'description': __('SMTP user password'),
            'type': 'string',
            'protected': true
        },
        {
            'name': 'security',
            'publicName': true,
            'description': __('Security mode: automatic (auto), socket ' +
                              'encryption (ssl), starttls command ' +
                              '(starttls) and no encryption (none)'),
            'default': 'auto',
            'schema': {
                type: 'string',
                enum: ['auto', 'ssl', 'starttls', 'none']
            },
            'compatVersions': ['>= 1.1', 'latest'],
        },
        {
            'name': 'authMethod',
            'publicName': true,
            'description': __('Preferred authentication method'),
            'default': 'PLAIN',
            'schema': {
                type: 'string',
                enum: ['CRAM-MD5', 'LOGIN', 'PLAIN', 'XOAUTH2']
            },
            'compatVersions': ['>= 1.1', 'latest'],
        },
        {
            'name': 'rejectUnauthorized',
            'publicName': true,
            'description': __('Reject any connection which is not authorized ' +
                  'with the list of supplied CAs. Set it to "false" if SMTP ' +
                  'server uses self-signed certificate'),
            'type': 'boolean',
            default: true,
        },
        {
            'name': 'debug',
            'description':
                __('If true, print full dump of SMTP dialog to the stdout'),
            'type': 'boolean',
            default: false,
        },
        {
            'name': 'timeout',
            'publicName': true,
            'description':
                __('Timeout interval in milliseconds'),
            'schema': {
                'type': 'integer',
                'minimum': 0
            },
            default: 15000,
        },

        // Compatibility with old REST API
        {
            'name': 'useSsl',
            'publicName': true,
            'volatile': true,
            'description': __('SMTP uses SSL'),
            'type': 'boolean',
            'compatVersions': ['1.0'],
            'setter': compatibility.useSslSetter,
            'getter': compatibility.useSslGetter,
        },
        {
            'name': 'useTls',
            'publicName': true,
            'volatile': true,
            'description': __('SMTP uses STARTTLS'),
            'type': 'boolean',
            'compatVersions': ['1.0'],
            'setter': compatibility.useTlsSetter,
            'getter': compatibility.useTlsGetter,
        },
        {
            'name': 'authMethods',
            'description': __('List of preferred authentication methods'),
            'publicName': true,
            'volatile': true,
            'schema': {
                type: 'array',
                items: {
                    type: 'string',
                    enum: ['CRAM-MD5', 'LOGIN', 'PLAIN', 'XOAUTH2']
                }
            },
            'compatVersions': ['1.0'],
            'setter': compatibility.authMethodsSetter,
            'getter': compatibility.authMethodsGetter
        }
    ],
    migrations: {
        from1to2: function(task, props, done) {
            // Obsolete values: 'useSsl, useTls' replaced with 'secure'
            // (authMethods) now only preferred method (authMethod)
            if (props.authMethods !== undefined) {
                props.authMethod = props.authMethods[0];
            }

            if (props.useSsl) {
                props.security = 'ssl';
            } else if (props.useTls) {
                props.security = 'starttls';
            }

            delete(props.authMethods);
            delete(props.useSsl);
            delete(props.useTls);
            done(undefined, props);
        },
    }
};

module.exports.init = function init(worker, callback) {
    callback(undefined, new Module({
        worker: worker,
        config: config
    }));
};
