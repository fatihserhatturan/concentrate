// default require
const utils = require('./utils');
const helper = require('./utils').helper;

// destructured require with aliased binding
const { foo, bar, baz: myBaz } = require('./lib');

if (process.env.LOAD_EXTRA) {
  const conditional = require('./conditional');
  conditional.extra();
}

// require with variable specifier — no Import node expected
const mod = require(utils.name);

function run() {
  utils.helper();
  helper();
  foo();
  bar();
  myBaz();
}
