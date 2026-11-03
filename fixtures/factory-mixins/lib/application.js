'use strict';

var app = exports = module.exports = {};

app.init = function init() {
  this.settings = {};
};

app.handle = function handle(req, res) {
  res.end();
};

app.use = function use(fn) {
  return this;
};

app.listen = function listen() {
  return require('node:http').createServer(this);
};
