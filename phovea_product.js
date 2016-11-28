/**
 * Created by Samuel Gratzl on 28.11.2016.
 */

module.exports = [
  {
    type: 'web__',
    name: 'taco',
    repo: 'caleydo/taco',
    branch: 'migrate',
    additional: []
  },
  {
    type: 'api',
    name: 'taco_server',
    repo: 'caleydo/taco_server',
    branch: 'migrate',
    additional: [{
      repo: 'phovea/phovea_data_hdf',
      branch: 'master'
    }]
  }
];