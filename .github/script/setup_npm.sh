#!/bin/bash
set -e

{
    echo "registry=https://greenlight.jfrog.io/artifactory/api/npm/npm/"
    curl -u "${ARTIFACTORY_USERNAME}:${ARTIFACTORY_TOKEN}" https://greenlight.jfrog.io/artifactory/api/npm/auth
} > .npmrc
