var express = require('./');

var app = express();

app.use(function logger(req, res, next) { next(); });
app.listen(3000);
