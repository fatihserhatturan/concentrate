const express = require('express');

function list(req, res) {
  res.json([]);
}

function stats(req, res) {
  res.json({});
}

const admin = express.Router();
admin.get('/stats', stats);

const apiv1 = express.Router();
apiv1.get('/users', list);
apiv1.use('/admin', admin);

module.exports = apiv1;
