#!/usr/bin/env bash
set -euo pipefail
# Qualification-only pinned native dependency, not application installation advice.
[[ "$(uname -m)" == "x86_64" ]]
package_file="${RUNNER_TEMP:?}/typed-sql-msodbcsql18.deb"
curl --fail --location --retry 3 --output "$package_file" https://packages.microsoft.com/ubuntu/24.04/prod/pool/main/m/msodbcsql18/msodbcsql18_18.7.1.1-1_amd64.deb
printf '%s  %s\n' f506cb3de8b34cd94e9014d247b39e9dfd7effad79edad3ab67096dc3c1b6b0e "$package_file" | sha256sum --check
sudo apt-get update
sudo apt-get install --yes unixodbc-dev
sudo env ACCEPT_EULA=Y apt-get install --yes "$package_file"
odbcinst -j
