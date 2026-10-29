const express = require('express');

const app = express();
app.use('/v1', require('./v1'));

const v2 = require('./v2');
app.use('/v2', v2);

app.use(require('missing-router'));

module.exports = app;
