'use strict';

const {
  readSecret,
  writeSecret,
  clearSecret,
  lookupKeyring,
  secretPath,
} = require('./plugin_secret');

const TOKEN_FILE = 'discord.token';

function readToken() {
  return readSecret(TOKEN_FILE);
}

function writeToken(token) {
  writeSecret(TOKEN_FILE, token);
}

function clearToken() {
  clearSecret(TOKEN_FILE);
}

function tokenPath() {
  return secretPath(TOKEN_FILE);
}

function trySeedFromKeyring() {
  return lookupKeyring({ service: 'discordo', username: 'token' });
}

module.exports = {
  readToken,
  writeToken,
  clearToken,
  trySeedFromKeyring,
  tokenPath,
};
