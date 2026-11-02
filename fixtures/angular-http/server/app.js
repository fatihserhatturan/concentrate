const express = require('express');

const app = express();

app.get('/api/articles', (req, res) => res.json([]));
app.post('/api/articles', (req, res) => res.status(201).end());
app.get('/api/articles/:slug', (req, res) => res.json({}));
app.put('/api/articles/:slug', (req, res) => res.end());
app.delete('/api/articles/:slug', (req, res) => res.end());
app.get('/api/tags', (req, res) => res.json([]));
app.post('/api/users/login', (req, res) => res.json({}));

module.exports = app;
