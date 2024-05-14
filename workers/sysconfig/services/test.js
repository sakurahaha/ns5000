var nef = require('nef');
var Service = require('nef/sysconfig/service');

var testSvc = new Service('test',
    __('Service for testing implementation of NEF service API'), {
        scalar: 'test.aValue',
        obj: 'test.anObject',
        rebootTest: 'test.rebootTest'
    }
);

module.exports = testSvc;
