const express = require('express');

function ping(req, res) {
  res.send('pong');
}

const r = express.Router();
r.get('/ping', ping);

module.exports = r;
