/**
 * Plugin to our REST server for generating flamegraph for
 * arbitrary running worker. Note that it is a kind of short-term solution,
 * which is likely to go away in future and it isn't part of official REST
 * interface.
 */

var assert  = require('assert');
var path    = require('path');
var spawn   = require('child_process').spawn;
var logger  = require('nef/logger');
var interop = require('nef/interop');
var NefError = require('nef/error').NefError;

var SCRIPT = path.join(process.env['NEF_CORE_ROOT'], 'devtools',
        'flamegraph.sh');

// Flamegraphs indexed by worker name
flamegraphs = {};

var htmlPreamble = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8" />',
    '<title>NEF worker flamegraphs</title>',
    '</head>',
    '<body>',
    '<div>'
].join('\n');

var htmlPostamble = [
    '</div>',
    '</body>',
    '</html>'
].join('\n');

/**
 * Generate form for submitting request to generate flamegraph for particular
 * worker.
 */
function generateForm(workers) {
    var body = [
        '<form method="post">',
        '<fieldset>',
        '<label for="worker">Worker:</label>',
        '<select id="worker" name="worker">',
        workers.map(function(w) {
            return '<option value="' + w + '">' + w + '</option>';
        }),
        '</select>',
        '<label for="time">Sampling period in seconds:</label>',
        '<input type="text" id="time" name="time" placeholder="60" />',
        '<input type="submit" value="Generate" />',
        '</form>'
    ].join('\n');

    return [htmlPreamble, body, htmlPostamble].join('\n');
}

/**
 * Generate flamegraph by executing a script from devtools.
 */
function generateFlamegraph(pid, time, done) {
    var args = ['-p', pid];
    var script;
    var stderr = '';
    var stdout = '';
    var errorSeen = false;

    if (time) {
        args = args.concat(['-t', time]);
    }
    logger.debug(__('Generating flame graph: %s %s', SCRIPT, args.join(' ')));

    script = spawn(SCRIPT, args);

    script.on('error', function(err) {
        errorSeen = true;
        done(NefError(err, __('Cannot execute %s', SCRIPT)));
    });
    script.on('exit', function(code) {
        if (errorSeen) {
            // done() callback already called
            return;
        }
        if (code !== 0) {
            var err = NefError('EFAILED',
                    __('Flamegraph script failed: %s', stderr));
            logger.error(__('Flame graph failed: %s', stderr));
            done(err);
            return;
        }
        logger.debug(__('Flame graph done'));
        done(null, stdout);
    });
    script.stderr.on('data', function(data) {
        stderr += data;
    });
    script.stdout.on('data', function(data) {
        stdout += data;
    });
}

/**
 * Register flamegraph URLs.
 */
module.exports.register = function registerFlamegraphs(server, path) {

    server.get(path, function(req, res) {
        res.contentType = 'text/html';
        interop.call('procman', 'findWorkers', {
            where: {
                running: true
            },
            fields: ['name']
        }, function(err, data) {
            if (err) {
                res.send(500, err.toString());
                return;
            }
            res.send(200, generateForm(data.map(function(ent) {
                return ent.name;
            }).sort()));
        });
    });

    server.get(path + '/:worker', function(req, res) {
        var worker = req.params.worker;

        res.contentType = 'text/html';
        if (!flamegraphs[worker]) {
            res.send(404, 'Flamegraph for worker ' + worker +
                    ' has not been generated');
            return;
        }
        res.send(200, flamegraphs[worker]);
    });

    server.post(path, function(req, res) {
        var name = req.body.worker;
        var time = req.body.time;

        res.contentType = 'text/html';
        if (time) {
            time = parseInt(time);
            if (time.toString() === 'NaN' || time <= 0) {
                res.send(400, 'Time period must be positive integer');
                return;
            }
        }

        interop.call('procman', 'findWorkers', {
            where: {
                name: name
            },
            fields: ['pid']
        }, function(err, data) {
            if (err) {
                res.send(500, err.toString());
                return;
            }
            if (data.length === 0) {
                res.send(404, 'Worker ' + name + ' not found');
                return;
            }
            assert.strictEqual(data.length, 1);
            if (!data[0].pid) {
                res.send(404, 'Worker ' + name + ' does not run');
                return;
            }
            generateFlamegraph(data[0].pid, time, function(err, fg) {
                if (err) {
                    res.send(500, err.toString());
                    return;
                }
                flamegraphs[name] = fg;
                res.send(303, null, {
                    Location: path + '/' + name
                });
            });
        });
    });
};
