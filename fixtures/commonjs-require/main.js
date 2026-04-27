// default require
const utils = require('./utils');

// destructured require with aliased binding
const { foo, bar, baz: myBaz } = require('./lib');

// require with variable specifier — no Import node expected
const mod = require(utils.name);

function run() {
  utils.helper();
  foo();
  bar();
  myBaz();
}
