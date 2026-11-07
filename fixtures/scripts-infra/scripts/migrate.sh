#!/bin/sh
psql "$DATABASE_URL" -c "select 1"
