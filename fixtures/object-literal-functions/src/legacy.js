const axios = require('axios');

module.exports = {
  profile(username) {
    return axios.get(`/api/profiles/${username}`);
  },
};
