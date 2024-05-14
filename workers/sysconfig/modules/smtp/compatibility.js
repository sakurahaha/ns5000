var logger = require('nef/logger');
var _ = require('lodash');

FROM_SECURITY_MAP = {
    ssl: 'true+false',
    auto: 'true+true',
    none: 'false+false',
    starttls: 'false+true'
};
TO_SECURITY_MAP = _.invert(FROM_SECURITY_MAP);

module.exports.authMethodsSetter = function(prop, ctx, value, done) {
    value = value || ['PLAIN'];
    logger.warn(__('Backward compatibility wrapper: only first element ' +
                'for smtp.authMethods is saved'));
    prop.module.getProperty('authMethod').set({
        ctx: ctx,
        value: value[0],
        persistent: true
    }, done);
};

module.exports.authMethodsGetter = function(prop, ctx, done) {
    done(undefined, [prop.module.getProperty('authMethod').tValue]);
};

module.exports.useSslSetter = function(prop, ctx, value, done) {
    genericSslTlsSetter('useSsl', prop, ctx, value, done);
};

module.exports.useSslGetter = function(prop, ctx, done) {
    genericSslTlsGetter('useSsl', prop, ctx, done);
};

module.exports.useTlsSetter = function(prop, ctx, value, done) {
    genericSslTlsSetter('useTls', prop, ctx, value, done);
};

module.exports.useTlsGetter = function(prop, ctx, done) {
    genericSslTlsGetter('useTls', prop, ctx, done);
};

/*
 * Helpers
 */

function genericSslTlsSetter(part, prop, ctx, value, done) {
    var sec = prop.module.getProperty('security').tValue;
    var pair = fromSecurity(sec);
    pair[part] = value;

    prop.module.getProperty('security').set({
        ctx: ctx,
        value: toSecurity(pair),
        persistent: true
    }, done);
}

function genericSslTlsGetter(part, prop, ctx, done) {
    var sec = prop.module.getProperty('security').tValue;
    var pair = fromSecurity(sec);
    done(undefined, pair[part]);
}

function toSecurity(pair) {
    return TO_SECURITY_MAP[`${pair.useSsl}+${pair.useTls}`] || 'none';
}

function fromSecurity(security) {
    var value = FROM_SECURITY_MAP[security] || 'false+false';
    var [useSsl, useTls] = value.split('+');
    return {
        useSsl: useSsl == 'true',
        useTls: useTls == 'true'
    };
}
