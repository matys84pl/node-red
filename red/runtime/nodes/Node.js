/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

const util = require("util");
const EventEmitter = require("events").EventEmitter;
const when = require("when");
const redUtil = require("../util");
const Log = require("../log");
const context = require("./context");
const flows = require("./flows");

let nodesCount = 0;

function Node(n, runtime) {
    this.id = n.id;
    this.type = n.type; // function, debug, custom type
    this.name = n.name; // node's name
    this.parentId = this.z = n.z; // ibm, wtf is z?
    this.runtime = runtime; // hack: runtime to handle post requests
    this.configNodeName = n.configNodeName; // name of the configuration node
    this.configNodeId = n.configNodeId; // id of the configuration node
    this.isInject = n.isInject; // whether the node has a button in the admin
    this.actions = n.actions; // actions associated with this node
    this.action = n.action; // action associated with this node
    this._closeCallbacks = [];
    this._alias = n._alias;

    Log.debug(`Creating new node [${nodesCount++}]`, {
        id: this.id,
        type: this.type,
        isInject: this.isInject,
        actions: this.actions,
    });

    if (runtime) {
        const {
            auth,
            adminApp,
        } = runtime.adminApi;

        adminApp.post(`/nodeInput/${this.id}`, auth.needsPermission("inject.write"), this.handleInputRequest.bind(this));
        adminApp.post(`/nodeStatus/${this.id}`, auth.needsPermission("inject.write"), this.handleStatusRequest.bind(this));
    }

    this.updateWires(n.wires);
}

Node.prototype.handleInputRequest = function (req, res) {
    try {
        Log.debug('Node received input REST request');
        this.receive({ payload: Math.random() * 10 });
        res.sendStatus(200);
    } catch (err) {
        res.sendStatus(500);
        this.error(runtime._("inject.failed", {error: err.toString()}));
    }
}

Node.prototype.handleStatusRequest = function (req, res) {
    try {
        Log.debug('Node received status REST request');
        this.status(req.body);
        res.sendStatus(200);
    } catch (err) {
        res.sendStatus(500);
        this.error(runtime._("status.failed", {error: err.toString()}));
    }
}

util.inherits(Node, EventEmitter);

Node.prototype.updateWires = function (wires) {
    console.log("UPDATE",this.id, this.configNodeId);
    this.wires = wires || [];
    delete this._wire;

    var wc = 0;
    this.wires.forEach(function (w) {
        wc += w.length;
    });
    this._wireCount = wc;
    if (wc === 0) {
        // With nothing wired to the node, no-op send
        this.send = function (msg) {
        }
    } else {
        this.send = Node.prototype.send;
        if (this.wires.length === 1 && this.wires[0].length === 1) {
            // Single wire, so we can shortcut the send when
            // a single message is sent
            this._wire = this.wires[0][0];
        }
    }
}

Node.prototype.context = function () {
    if (!this._context) {
        this._context = context.get(this._alias || this.id, this.z);
    }
    return this._context;
}

Node.prototype._on = Node.prototype.on;

Node.prototype.on = function (event, callback) {
    var node = this;
    if (event == "close") {
        this._closeCallbacks.push(callback);
    } else {
        this._on(event, callback);
    }
};

Node.prototype.close = function (removed) {
    //console.log(this.type,this.id,removed);
    var promises = [];
    var node = this;
    for (var i = 0; i < this._closeCallbacks.length; i++) {
        var callback = this._closeCallbacks[i];
        if (callback.length > 0) {
            promises.push(
                when.promise(function (resolve) {
                    var args = [];
                    if (callback.length === 2) {
                        args.push(!!removed);
                    }
                    args.push(resolve);
                    callback.apply(node, args);
                })
            );
        } else {
            callback.call(node);
        }
    }
    if (promises.length > 0) {
        return when.settle(promises).then(function () {
            if (this._context) {
                context.delete(this._alias || this.id, this.z);
            }
        });
    } else {
        if (this._context) {
            context.delete(this._alias || this.id, this.z);
        }
        return;
    }
};

Node.prototype.send = function (msg) {
    var msgSent = false;
    var node;

    if (msg === null || typeof msg === "undefined") {
        return;
    } else if (!util.isArray(msg)) {
        if (this._wire) {
            // A single message and a single wire on output 0
            // TODO: pre-load flows.get calls - cannot do in constructor
            //       as not all nodes are defined at that point
            if (!msg._msgid) {
                msg._msgid = redUtil.generateId();
            }
            this.metric("send", msg);
            node = flows.get(this._wire);
            /* istanbul ignore else */
            if (node) {
                node.receive(msg);
            }
            return;
        } else {
            msg = [msg];
        }
    }

    var numOutputs = this.wires.length;

    // Build a list of send events so that all cloning is done before
    // any calls to node.receive
    var sendEvents = [];

    var sentMessageId = null;

    // for each output of node eg. [msgs to output 0, msgs to output 1, ...]
    for (var i = 0; i < numOutputs; i++) {
        var wires = this.wires[i]; // wires leaving output i
        /* istanbul ignore else */
        if (i < msg.length) {
            var msgs = msg[i]; // msgs going to output i
            if (msgs !== null && typeof msgs !== "undefined") {
                if (!util.isArray(msgs)) {
                    msgs = [msgs];
                }
                var k = 0;
                // for each recipent node of that output
                for (var j = 0; j < wires.length; j++) {
                    node = flows.get(wires[j]); // node at end of wire j
                    if (node) {
                        // for each msg to send eg. [[m1, m2, ...], ...]
                        for (k = 0; k < msgs.length; k++) {
                            var m = msgs[k];
                            if (m !== null && m !== undefined) {
                                /* istanbul ignore else */
                                if (!sentMessageId) {
                                    sentMessageId = m._msgid;
                                }
                                if (msgSent) {
                                    var clonedmsg = redUtil.cloneMessage(m);
                                    sendEvents.push({n: node, m: clonedmsg});
                                } else {
                                    sendEvents.push({n: node, m: m});
                                    msgSent = true;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    /* istanbul ignore else */
    if (!sentMessageId) {
        sentMessageId = redUtil.generateId();
    }
    this.metric("send", {_msgid: sentMessageId});

    for (i = 0; i < sendEvents.length; i++) {
        var ev = sendEvents[i];
        /* istanbul ignore else */
        if (!ev.m._msgid) {
            ev.m._msgid = sentMessageId;
        }
        ev.n.receive(ev.m);
    }
};

Node.prototype.receive = function (msg) {
    if (!msg) {
        msg = {};
    }
    if (!msg._msgid) {
        msg._msgid = redUtil.generateId();
    }
    this.metric("receive", msg);
    try {
        this.emit("input", msg);
    } catch (err) {
        this.error(err, msg);
    }
};

function log_helper(self, level, msg) {
    var o = {
        level: level,
        id: self.id,
        type: self.type,
        msg: msg
    };
    if (self._alias) {
        o._alias = self._alias;
    }
    if (self.z) {
        o.z = self.z;
    }
    if (self.name) {
        o.name = self.name;
    }
    if (self.configNodeId) {
        o.configNodeId = self.configNodeId;
    }
    if (self.isInject) {
        o.isInject = self.isInject;
    }
    if (self.actions) {
        o.actions = self.actions;
    }
    Log.log(o);
}

Node.prototype.log = function (msg) {
    log_helper(this, Log.INFO, msg);
};

Node.prototype.warn = function (msg) {
    log_helper(this, Log.WARN, msg);
};

Node.prototype.error = function (logMessage, msg) {
    if (typeof logMessage != 'boolean') {
        logMessage = logMessage || "";
    }
    var handled = false;
    if (msg) {
        handled = flows.handleError(this, logMessage, msg);
    }
    if (!handled) {
        log_helper(this, Log.ERROR, logMessage);
    }
};

Node.prototype.debug = function (msg) {
    log_helper(this, Log.DEBUG, msg);
}

Node.prototype.trace = function (msg) {
    log_helper(this, Log.TRACE, msg);
}

/**
 * If called with no args, returns whether metric collection is enabled
 */
Node.prototype.metric = function (eventname, msg, metricValue) {
    if (typeof eventname === "undefined") {
        return Log.metric();
    }
    var metrics = {};
    metrics.level = Log.METRIC;
    metrics.nodeid = this.id;
    metrics.event = "node." + this.type + "." + eventname;
    metrics.msgid = msg._msgid;
    metrics.value = metricValue;
    Log.log(metrics);
}

/**
 * status: { fill:"red|green", shape:"dot|ring", text:"blah" }
 */
Node.prototype.status = function (status) {
    flows.handleStatus(this, status);
};

/**
 * Sets the status on the parent (to be used within subflows)
 * @param status
 */
Node.prototype.parentStatus = function (status) {
    const parentNode = flows.get(this.parentId);
    flows.handleStatus(parentNode, status);
};

module.exports = Node;
