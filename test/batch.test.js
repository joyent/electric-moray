/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

var path = require('path');
var uuidv4 = require('uuid/v4');
var vasync = require('vasync');
var VError = require('verror');

if (require.cache[__dirname + '/helper.js'])
    delete require.cache[__dirname + '/helper.js'];
var helper = require('./helper.js');



// --- Globals

var after = helper.after;
var before = helper.before;
var test = helper.test;

var BUCKET_CFG = {
    index: {
        str: {
            type: 'string'
        },
        str_u: {
            type: 'string',
            unique: true
        },
        str_2: {
            type: 'string'
        },
        num: {
            type: 'number'
        },
        num_u: {
            type: 'number',
            unique: true
        },
        bool: {
            type: 'boolean'
        },
        bool_u: {
            type: 'boolean',
            unique: true
        }
    },
    pre: [function (req, cb) {
        var v = req.value;
        if (v.pre)
            v.pre = 'pre_overwrite';

        cb();
    }],
    post: [function (req, cb) {
        cb();
    }],
    options: {
        guaranteeOrder: true
    }
};



///--- Helpers

/*
 * Run a batch request that should result in an error and check its
 * message.
 */
function runBadBatch(c, t, requests, expMsg) {
    c.batch(requests, function (bErr, meta) {
        t.ok(bErr, 'error expected');
        if (bErr) {
            t.equal(bErr.message, expMsg, 'correct error message');
        }

        t.equal(meta, null, 'no return value');

        t.end();
    });
}


/*
 * Initialize an empty object to be manipulated by a 'delete' request.
 */
function initEmptyObject(c, r, cb) {
    c.putObject(r.bucket, r.key, {}, { etag: null }, cb);
}


/*
 * Get an object that was created by a 'put' request, and verify that
 * it has the expected value.
 */
function checkObject(c, t, r, cb) {
    c.getObject(r.bucket, r.key, function (err, obj) {
        t.ifError(err);
        t.ok(obj);
        if (obj) {
            t.deepEqual(obj.value, r.value);
        }

        cb();
    });
}


/*
 * Assert that an object doesn't exist.
 */
function checkNoObject(c, t, r, cb) {
    c.getObject(r.bucket, r.key, function (gErr, obj) {
        t.ok(gErr, 'error expected');
        if (gErr) {
            t.ok(VError.hasCauseWithName(gErr, 'ObjectNotFoundError'),
                'Object not found');
        }

        t.equal(obj, null, 'no object returned');

        cb();
    });
}


///--- Tests

/*
 * Set up two buckets before every test: one which transforms keys,
 * and one which doesn't.
 */
before(function (cb) {
    var self = this;
    this.bucket1 = 'testmanta';
    this.bucket2 = 'notransform';
    this.client = helper.createClient();
    this.client.on('connect', function () {
        self.client.createBucket(self.bucket1, BUCKET_CFG, function (err1) {
            if (err1) {
                console.error(err1.stack);
                cb(err1);
                return;
            }

            self.client.createBucket(self.bucket2, BUCKET_CFG, function (err2) {
                if (err2) {
                    console.error(err2.stack);
                }

                cb(err2);
            });
        });
    });
});


after(function (cb) {
    var self = this;
    self.client.delBucket(self.bucket1, function (err1) {
        if (err1) {
            console.error(err1.stack);
        }

        self.client.delBucket(self.bucket2, function (err2) {
            if (err2) {
                console.error(err2.stack);
            }

            self.client.close();
            cb(err1 || err2);
        });
    });
});


test('single operation: "put"', function (t) {
    var self = this;
    var requests = [
        {
            operation: 'put',
            bucket: self.bucket1,
            key: path.join('/', uuidv4(), 'stor', uuidv4()),
            value: {
                foo: 'bar'
            }
        }
    ];

    self.client.batch(requests, function (bErr, meta) {
        if (bErr) {
            t.ifError(bErr, 'batch()');
            t.end();
            return;
        }

        t.ok(meta);
        t.ok(meta.etags);
        if (meta.etags) {
            t.ok(Array.isArray(meta.etags));
            t.equal(meta.etags.length, requests.length);
            meta.etags.forEach(function (e) {
                t.equal(requests[0].bucket, e.bucket);
                t.ok(e.etag, 'has etag');
            });
        }

        checkObject(self.client, t, requests[0], function (err) {
            t.ifError(err, 'pipeline should succeed');
            t.end();
        });
    });
});


test('single operation: "delete"', function (t) {
    var c = this.client;
    var self = this;
    var prefixdir = path.join('/', uuidv4(), 'stor');
    var requests = [
        {
            operation: 'delete',
            bucket: self.bucket1,
            key: path.join(prefixdir, uuidv4())
        }
    ];

    vasync.pipeline({ funcs: [
        function (_, cb) {
            initEmptyObject(c, requests[0], cb);
        },
        function (_, cb) {
            c.batch(requests, function (bErr, meta) {
                if (bErr) {
                    cb(bErr);
                    return;
                }

                t.ok(meta);
                t.ok(meta.etags);
                if (meta.etags) {
                    t.ok(Array.isArray(meta.etags));
                    t.equal(meta.etags.length, requests.length);
                    meta.etags.forEach(function (e) {
                        t.equal(requests[0].key, e.key);
                        t.equal(requests[0].bucket, e.bucket);
                        t.equal(undefined, e.etag, 'no etag');
                    });
                }

                cb();
            });
        },
        function (_, cb) {
            checkNoObject(c, t, requests[0], cb);
        }
    ] }, function (err) {
        t.ifError(err, 'pipeline should succeed');
        t.end();
    });
});


test('keys in batch transform to same value (1 bucket)', function (t) {
    var c = this.client;
    var self = this;
    var prefixdir = path.join('/', uuidv4(), 'stor');
    var requests = [
        {
            bucket: self.bucket1,
            key: path.join(prefixdir, uuidv4()),
            value: {
                foo: 'bar'
            }
        },
        {
            bucket: self.bucket1,
            key: path.join(prefixdir, uuidv4()),
            value: {
                bar: 'baz'
            }
        }
    ];

    c.batch(requests, function (bErr, meta) {
        if (bErr) {
            t.ifError(bErr, 'batch()');
            t.end();
            return;
        }

        t.ok(meta);
        t.ok(meta.etags);
        if (meta.etags) {
            t.ok(Array.isArray(meta.etags));
            t.equal(meta.etags.length, requests.length);
            meta.etags.forEach(function (e) {
                switch (e.key) {
                case requests[0].key:
                    t.equal(requests[0].bucket, e.bucket);
                    t.ok(e.etag, 'has etag');
                    return;
                case requests[1].key:
                    t.equal(requests[1].bucket, e.bucket);
                    t.ok(e.etag, 'has etag');
                    return;
                default:
                    t.fail('unrecognized key: ' + JSON.stringify(e));
                    return;
                }
            });
        }

        vasync.forEachPipeline({
            inputs: requests,
            func: checkObject.bind(null, c, t)
        }, function (err) {
            t.ifError(err, 'pipeline should succeed');
            t.end();
        });
    });
});


test('keys in batch transform to same value (2 buckets)', function (t) {
    var c = this.client;
    var self = this;
    var prefixdir = path.join('/', uuidv4(), 'stor');
    var requests = [
        {
            bucket: self.bucket1,
            key: path.join(prefixdir, uuidv4()),
            value: {
                foo: 'bar'
            }
        },
        {
            bucket: self.bucket2,
            key: prefixdir,
            value: {
                bar: 'baz'
            }
        }
    ];

    c.batch(requests, function (bErr, meta) {
        if (bErr) {
            t.ifError(bErr, 'batch()');
            t.end();
            return;
        }

        t.ok(meta);
        t.ok(meta.etags);
        if (meta.etags) {
            t.ok(Array.isArray(meta.etags));
            t.equal(meta.etags.length, requests.length);
            meta.etags.forEach(function (e) {
                switch (e.key) {
                case requests[0].key:
                    t.equal(requests[0].bucket, e.bucket);
                    t.ok(e.etag, 'has etag');
                    return;
                case requests[1].key:
                    t.equal(requests[1].bucket, e.bucket);
                    t.ok(e.etag, 'has etag');
                    return;
                default:
                    t.fail('unrecognized key: ' + JSON.stringify(e));
                    return;
                }
            });
        }

        vasync.forEachPipeline({
            inputs: requests,
            func: checkObject.bind(null, c, t)
        }, function (err) {
            t.ifError(err, 'pipeline should succeed');
            t.end();
        });
    });
});


test('keys in batch transform to different value', function (t) {
    var prefixdir1 = path.join('/', uuidv4(), 'stor');
    var prefixdir2 = path.join('/', uuidv4(), 'stor');
    var requests = [
        {
            bucket: this.bucket1,
            key: path.join(prefixdir1, uuidv4()),
            value: {
                foo: 'bar'
            }
        },
        {
            bucket: this.bucket1,
            key: path.join(prefixdir2, uuidv4()),
            value: {
                bar: 'baz'
            }
        }
    ];

    runBadBatch(this.client, t, requests,
        'all requests must transform to the same key');
});


test('same key transforms to different values', function (t) {
    var key = path.join('/', uuidv4(), 'stor', uuidv4());
    var requests = [
        {
            bucket: this.bucket1,
            key: key,
            value: {
                foo: 'bar'
            }
        },
        {
            bucket: this.bucket2,
            key: key,
            value: {
                bar: 'baz'
            }
        }
    ];

    runBadBatch(this.client, t, requests,
        'all requests must transform to the same key');
});


test('unsupported batch operation: "update"', function (t) {
    var key = path.join('/', uuidv4(), 'stor', uuidv4());
    var requests = [
        {
            bucket: this.bucket1,
            key: key,
            value: {
                foo: 'bar'
            }
        },
        {
            operation: 'update',
            bucket: this.bucket1,
            filter: '(num=5)',
            fields: { str: 'hello' }
        }
    ];

    runBadBatch(this.client, t, requests,
        '"update" is not an allowed batch operation');
});


test('unsupported batch operation: "deleteMany"', function (t) {
    var key = path.join('/', uuidv4(), 'stor', uuidv4());
    var requests = [
        {
            bucket: this.bucket1,
            key: key,
            value: {
                foo: 'bar'
            }
        },
        {
            operation: 'deleteMany',
            bucket: this.bucket1,
            filter: '(num=5)'
        }
    ];

    runBadBatch(this.client, t, requests,
        '"deleteMany" is not an allowed batch operation');
});


test('mix of all valid operations', function (t) {
    var c = this.client;
    var self = this;
    var prefixdir = path.join('/', uuidv4(), 'stor', uuidv4());
    var requests = [
        {
            operation: 'delete',
            bucket: self.bucket1,
            key: path.join(prefixdir, uuidv4())
        },
        {
            bucket: self.bucket1,
            key: path.join(prefixdir, uuidv4()),
            value: {
                foo: 'bar'
            }
        },
        {
            operation: 'put',
            bucket: self.bucket2,
            key: prefixdir,
            value: {
                foo: 'bar'
            }
        }
    ];

    vasync.pipeline({ funcs: [
        function (_, cb) {
            initEmptyObject(c, requests[0], cb);
        },
        function (_, cb) {
            c.batch(requests, function (bErr, meta) {
                if (bErr) {
                    cb(bErr);
                    return;
                }

                t.ok(meta);
                t.ok(meta.etags);
                if (meta.etags) {
                    t.ok(Array.isArray(meta.etags));
                    t.equal(meta.etags.length, requests.length);
                    meta.etags.forEach(function (e) {
                        switch (e.key) {
                        case requests[0].key:
                            t.equal(requests[0].bucket, e.bucket);
                            t.equal(undefined, e.etag, 'no etag');
                            return;
                        case requests[1].key:
                            t.equal(requests[1].bucket, e.bucket);
                            t.ok(e.etag, 'has etag');
                            return;
                        case requests[2].key:
                            t.equal(requests[2].bucket, e.bucket);
                            t.ok(e.etag, 'has etag');
                            return;
                        default:
                            t.fail('unrecognized key: ' + JSON.stringify(e));
                            return;
                        }
                    });
                }

                cb();
            });
        },
        function (_, cb) {
            checkNoObject(c, t, requests[0], cb);
        },
        function (_, cb) {
            vasync.forEachPipeline({
                inputs: requests.slice(1),
                func: checkObject.bind(null, c, t)
            }, cb);
        }
    ] }, function (err) {
        t.ifError(err, 'pipeline should succeed');
        t.end();
    });
});
