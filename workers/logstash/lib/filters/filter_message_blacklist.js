var logger = require('nef/logger');
var baseFilter = require('../lib/base_filter');
var util = require('util');
var nef = require('nef');
var logger = require('nef/logger');

function FilterMessageBlacklist() {
    this.enabled = true;
    baseFilter.BaseFilter.call(this);
    this.mergeConfig({
        name: 'MessageBlacklist'
    });
};

util.inherits(FilterMessageBlacklist, baseFilter.BaseFilter);
var blacklistRules = [];

FilterMessageBlacklist.prototype.process = function(data) {
    if (this.enabled) {
        if (blacklistRules) {
            for (var rule of blacklistRules) {
                // Check severity.
                if (rule.severity === data.severity) {
                    // Check component.
                    for (var component of rule.component) {
                        if (data.component &&
                            data.component.startsWith(component)) {
                            // Check message.
                            if (data.message.indexOf(rule.pattern) >= 0) {
                                return null;
                            }
                        }
                    }
                }
            }
        }
        return data;
    }

    return null;
};

FilterMessageBlacklist.prototype.setBlacklist = function(blacklist) {
    if (blacklist) {
        var newRules = [];

        blacklist.forEach((bl) => {
            var match = bl.match('^(\\S+):(\\S+):(.+)$');

            if (!match) {
                logger.warn(__('Ignoring malformed blacklist rule: %s',
                    bl));
                return;
            }
            logger.info(__('Installing blacklist rule: %s', bl));

            var component = match[1];
            var components = [component];
            // We need to derive 2 patterns for the component to take
            // into account the PID part in brackets. If user doesn't ask
            // for [PID] part, assume it implicitly.
            if (component.indexOf('[') === -1) {
                components.push(component + '[');
            }

            newRules.push({
                component: components,
                severity: match[2],
                pattern: match[3]
            });
        });

        blacklistRules = newRules;
    } else {
        blacklistRules = [];
    }
};

FilterMessageBlacklist.prototype.enable = function(enable) {
    this.enabled = enable;
};

exports.create = function() {
    return new FilterMessageBlacklist();
};
