const apiUrl = process.env.API_URL;

function featureOn() {
  return process.env.FEATURE_FLAG === 'on';
}

// Read but declared in no env file.
function secret() {
  return process.env.SESSION_SECRET;
}

// Set by tooling, not reported.
const mode = process.env.NODE_ENV;

module.exports = { apiUrl, featureOn, secret, mode };
