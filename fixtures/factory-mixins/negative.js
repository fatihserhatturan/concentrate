var express = require('./');
var app = express();

function start(app) {
  app.listen(8080);
}

function plain() {
  return {};
}

var other = plain();
other.listen();
app.missing();
