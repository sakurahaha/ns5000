var NefError    = require('nef/error').NefError;

function ApiVersion(data) {
    this.major = undefined;
    this.minor = undefined;
    this.patch = undefined;
    this.acceptAny = false;

    if (data instanceof ApiVersion) {
        this.parseString(data.toString());
    } else {
        this.parseString(data);
    }

    return this;
}

ApiVersion.prototype.toString = function(short) {
    if (this.acceptAny && this.major == undefined) {
        return '*';
    }

    res = `${this.major}.${this.minor}`;

    if (!short && this.patch !== undefined) {
        res += '.' + this.patch;
    }
    return res;
};

/**
 * Main method to die if version is unsupported
 *
 * We make use of fact that supported versions passed as argument are sorted
 * from latest to oldest.
 */
ApiVersion.prototype.expandToOrDie = function(versions) {
    if (this.acceptAny) {
        this.parseString(versions[0].toString());
        return;
    }

    var matchedMajors = versions.filter(v => v.major === this.major);
    if (matchedMajors.length === 0) {
        throw NefError('ENOENT', __('Unsupported major version is requested. ' +
                                    'Current major version is %d.',
                                    versions[0].major));
    }
    var matchedMinors = matchedMajors.filter(v => v.minor === this.minor);
    if (matchedMinors.length === 0) {
        throw NefError('ENOENT', __('Unsupported minor version is requested. ' +
                  'Supported are %s.',
                  matchedMajors.map(v => v.toString(true)).join(', ')));
    }

    if (this.patch != undefined && this.patch > matchedMinors[0].patch) {
        throw NefError('ENOENT', __('Unsupported patch version is requested. ' +
                  'Highest supported patch version is %s.',
                  matchedMinors[0].toString()));
    }

    // Upgrade patch version to latest
    this.patch = matchedMinors[0].patch;
};

ApiVersion.prototype.parseString = function(str) {
    if (str == '*') {
        this.acceptAny = true;
        return;
    }

    var parts = str.split('.');
    if (parts.length > 3) {
        throw NefError('EBADARG', __('Version has more than 3 parts. ' +
                                     'It should be X.Y.Z'));
    } else if (parts.length < 2) {
        throw NefError('EBADARG', __('Version should be at least X.Y'));
    }

    this.major = parseInt(parts[0]);
    this.minor = parseInt(parts[1]);

    if (parts[2] != undefined) {
        this.patch = parseInt(parts[2]);
    }
};

/**
 * Custom method to check does ver in client request
 * satisfies border in endpoint definition.
 *
 * It should be always used as following:
 *   req.apiVersion.satisfies(NEEDED_VERSION)
 *
 * Custom logic is in missing patch version:
 *  X.Y extends to:
 *  - X.Y.<inf> in req.apiVersion
 *  - X.Y.0 in NEEDED_VERSION
 */
ApiVersion.prototype.satisfies = function(ver) {
    var other = new ApiVersion(ver);

    if (this.major !== other.major) {
        return this.major > other.major;
    }

    if (this.minor !== other.minor) {
        return this.minor > other.minor;
    }

    if (this.patch === undefined) {
        return true;
    }

    return this.patch >= (other.patch || 0);
};

ApiVersion.prototype.compatible = function(ver) {
    var other = new ApiVersion(ver);

    if (this.major !== other.major) {
        return false;
    }
    if (this.minor !== other.minor) {
        return false;
    }
    if (this.patch === undefined) {
        return true;
    }

    return this.patch >= (other.patch || 0);
};

module.exports.ApiVersion = ApiVersion;
