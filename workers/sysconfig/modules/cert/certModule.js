const funcs = require('./funcs.js');
const Module = require('nef/sysconfig/module.js');

var config = {
    name: 'cert',
    description: __('SSL certificates settings'),
    version: 1,
    properties: [
        {
            'name': 'authorities',
            'publicName': false,
            'allowedZones': ['global'],
            'description': __('Certification Authorities names'),
            'default': [],
            'schema': {
                type: 'array',
                items: {
                    description: 'Certification Authority name',
                    type: 'string'
                }
            },
            'getter': funcs.getCertAuthorities
        }, {
            'name': 'requests',
            'publicName': false,
            'allowedZones': ['global'],
            'description': __('Certificate Requests names'),
            'default': [],
            'schema': {
                type: 'array',
                items: {
                    description: 'Certificate Request name',
                    type: 'string'
                }
            },
            'getter': funcs.getRequests
        }, {
            'name': 'certificates',
            'publicName': false,
            'allowedZones': ['global'],
            'description': __('Certificates names'),
            'default': [],
            'schema': {
                type: 'array',
                items: {
                    description: 'Certificate name',
                    type: 'string'
                }
            },
            'getter': funcs.getCertificates
        }
    ]
};

module.exports.init = function init(worker, callback) {
    callback(undefined, new Module({
        worker: worker,
        config: config
    }));
};
