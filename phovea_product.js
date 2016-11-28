/**
 * Created by Samuel Gratzl on 28.11.2016.
 */

module.exports = [
  {
    type: 'web',
    name: 'taco',
    repo: 'caleydo/taco',
    branch: 'migrate',
    additional: []
  },
  {
    type: 'api',
    name: 'phovea/phovea_server',
    branch: 'master',
    additional: [{
      repo: 'caleydo/taco_server',
      branch: 'migrate'
    }, {
      repo: 'phovea/phovea_data_hdf',
      branch: 'master'
    }]
  }
];