var funcs = require('./funcs.js');
var Module = require('nef/sysconfig/module.js');
var nefUtils = require('nef/utils');

var TMP_FILE = '/tmp/nef-test-config.0';
funcs.setFile(TMP_FILE);

var config = {
    name: 'test',
    description: __('Test settings'),
    version: 5,
    watch: [TMP_FILE],
    serialize: true,
    properties: [
        {
            'name': 'stored',
            'description': __('Temp file 0 value'),
            'type': 'string',
            'getter': funcs.getStored,
            'setter': funcs.setStored,
            'persistentGetter': funcs.getStoredPersistently,
            'persistentSetter': funcs.setStoredPersistently
        },
        {
            'name': 'debug0',
            'description': __('Debug 0'),
            'type': 'string'
        },

        // Test properties
        {
            'name': 'aList',
            'publicName': true,
            'description': __('Some list with values'),
            'type': 'array',
            'default': [],
        },
        {
            'name': 'aValue',
            'publicName': true,
            'description': __('Some value'),
            'type': 'integer',
            'default': 42,
            'haSync': true,
        },
        {
            'name': 'aDate',
            'publicName': true,
            'description': __('Some date'),
            'schema': {
                'type': 'string',
                'format': 'date-time',
            }
        },
        {
            'name': 'anObject',
            'publicName': true,
            'description': __('Object value'),
            'schema': {
                type: 'object',
                properties: {
                    number: {
                        type: 'integer'
                    },
                    string: {
                        type: 'string'
                    },
                    flag: {
                        type: 'boolean'
                    }
                },
                additionalProperties: true // <--- must be here for BDD tests
            }
        },
        {
            'name': 'aFlag',
            'publicName': true,
            'description': __('Some boolean value'),
            'type': 'boolean',
            'default': true,
        },
        {
            'name': 'rebootTest',
            'publicName': true,
            'description': __('Set to reboot to test reboot process'),
            'type': 'string',
            'optionalReboot': true,
            'setter': funcs.rebootTest,
        },
        {
            'name': 'persistentThing',
            'description':
                __('Property that can be set or get only persistently'),
            'type': 'string',
            'persistentGetter': funcs.fakeGet,
            'persistentSetter': funcs.fakeSet
        },
        {
            'name': 'temporaryThing',
            'description':
                __('Property that can be set or get only temporary'),
            'type': 'string',
            'getter': funcs.fakeGet,
            'setter': funcs.fakeSet
        },
        {
            'name': 'readOnlyThing',
            'publicName': true,
            'description': __('Property that cannot be changed'),
            'type': 'string',
            'readOnly': true,
            'default': 'constant'
        },
        {
            'name': 'volatileThing',
            'publicName': true,
            'description': __('Property that changes always'),
            'type': 'integer',
            'volatile': true,
            'getter': function(done) {
                done(undefined, Math.ceil(Math.random() * 1000));
            },
        },
        {
            'name': 'volatileHaThing',
            'publicName': true,
            'description': __('Property that changes always and HA-friendly'),
            'type': 'integer',
            'volatile': true,
            'haSync': true,
            'getter': funcs.fakeGet,
            'setter': funcs.fakeSet
        },
        {
            'name': 'password',
            'publicName': true,
            'description': __('Property that should be masked'),
            'type': 'string',
            'protected': true
        },
        {
            'name': 'compatV10',
            'publicName': 'compat',
            'description': __('Property from API ver 1.0'),
            'type': 'string',
            'compatVersions': ['1.0'],
            'volatile': true,
            'getter': funcs.constantGetter('v1.0'),
        },
        {
            'name': 'compatV11',
            'publicName': 'newCompat',
            'description': __('Property from API ver 1.1'),
            'type': 'string',
            'compatVersions': ['>= 1.1', 'latest'],
            'volatile': true,
            'getter': funcs.constantGetter('v1.1'),
        },
        {
            'name': 'rollbackTest',
            'description': 'Property to test rollback feature',
            'type': 'string',
            'setter': funcs.rollbackTestSetter,
            'persistentSetter': funcs.rollbackTestPersistentSetter,
            'rollback': funcs.rollbackTestRollback
        },
        {
            'name': 'rollbackMeter',
            'description': 'Property that shows how rollback feature worked',
            'type': 'object'
        }
    ],

    // Those migrations are used in the migrations BDD tests
    migrations: {
        // Example of modification of scalar value
        from1to2: function(task, props, done) {
            if (props.aList !== undefined) {
                props.oldValue = props.oldValue + 15;
            }
            done(undefined, props);
        },

        // Example of altering array
        from2to3: function(task, props, done) {
            if (props.aList !== undefined) {
                props.aList.push('added in migration');
            }
            done(undefined, props);
        },

        // Example of renaming
        from3to4: function(task, props, done) {
            if (props.oldValue !== undefined) {
                props.aValue = props.oldValue;
                delete(props.oldValue);
            }
            done(undefined, props);
        },

        // Example of removing value
        from4to5: function(task, props, done) {
            delete(props.shouldBeRemoved);
            done(undefined, props);
        },
    },

};

module.exports.init = function init(worker, callback) {
    // Hide in production
    if (nefUtils.envIs('production')) {
        config.properties = [];
    }

    callback(undefined, new Module({
        worker: worker,
        config: config
    }));
};
