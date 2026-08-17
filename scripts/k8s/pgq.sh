#!/usr/bin/env bash
# usage: pgq.sh "<sql>"
docker exec -i opendb-dsh-pg psql -U dsh -d dsh -tAc "$1"
