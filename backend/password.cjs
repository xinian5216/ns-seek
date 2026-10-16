'use strict';
const crypto = require('node:crypto');
function strong(password) {
  return typeof password === 'string' && password.length >= 24 && password.length <= 128 && /^[!-~]+$/.test(password) &&
    /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password);
}
function hashPassword(password) {
  if (!strong(password)) throw new Error('weak_password');
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, digest: crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32).toString('hex') };
}
function verifyPassword(password, hash) {
  if (typeof password !== 'string' || password.length > 128 || !hash || !/^[a-f0-9]{32}$/.test(hash.salt) || !/^[a-f0-9]{64}$/.test(hash.digest)) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(password, Buffer.from(hash.salt, 'hex'), 32), Buffer.from(hash.digest, 'hex'));
}
module.exports = { strong, hashPassword, verifyPassword };
