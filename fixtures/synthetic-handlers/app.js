const express = require('express');

const app = express();

// Two path-less inline middlewares get the same synthetic name
// (`<app.use:arg0>`); each route must link to its own.
app.use(function logRequests(req, res, next) {
  console.log(req.method);
  next();
});

app.use(function (req, res, next) {
  res.setHeader('x-powered-by', 'fixture');
  next();
});

app.use(function (req, res, next) {
  res.setHeader('x-request-id', String(Date.now()));
  next();
});

// An inline middleware followed by an inline handler: the handler is the
// last argument, not the first inline function.
app.get('/health', (req, res, next) => {
  req.startedAt = Date.now();
  next();
}, (req, res) => {
  res.json({ ok: true });
});

function requireUser(req, res, next) {
  next();
}

// A named middleware followed by an inline handler.
app.get('/me', requireUser, (req, res) => {
  res.json({ user: req.user });
});

// A path held in a constant: the parser names the handler by the literal it
// sees (`<app.get:arg1>`), the route by the resolved path.
const STATUS_PATH = '/status';
app.get(STATUS_PATH, (req, res) => {
  res.json({ status: 'up' });
});

module.exports = app;
