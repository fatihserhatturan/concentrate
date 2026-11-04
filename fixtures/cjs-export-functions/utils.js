'use strict';

// Anonymous functions assigned to exports are named by the property.
exports.compileETag = function (val) {
  return normalize(val);
};

module.exports.normalize = (val) => String(val);

exports.named = function inner(val) {
  return val;
};

// Not a function: stays a variable.
exports.methods = ['get', 'post'];

if (process.env.DEBUG) {
  // Not module-level: no Function of its own.
  exports.debug = function (message) {
    return message;
  };
}

function normalize(val) {
  return exports.normalize(val);
}
