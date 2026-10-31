#!/bin/sh
set -e
cd "$(dirname "$0")/.."
rm -rf www
mkdir www
cp index.html app.js styles.css track.html tilauskysely-explainer.jpg www/
