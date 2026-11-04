'use strict';

var compileETag = require('./utils').compileETag;
var utils = require('./utils');

function set(val) {
  return compileETag(val);
}

utils.compileETag(true);
utils.named(1);

module.exports = { set };
