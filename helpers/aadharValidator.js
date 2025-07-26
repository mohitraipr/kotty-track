function isValidAadhar(num) {
  return typeof num === 'string' && /^\d{12}$/.test(num);
}

module.exports = { isValidAadhar };
