function start(port) { return port; }
function setup() {}
function fallback() {}
function stop(error) { return error; }
function cleanup() {}
function inLoop(value) { return value; }

module.exports = { start, setup, fallback, stop, cleanup, inLoop };
