/**
 * Created by Samuel Gratzl on 28.11.2016.
 */

module.exports = [
  {
    type: 'web__',
    name: 'taco',
    repo: 'Caleydo/taco',
    branch: 'deploy',
    additional: []
  },
  {
    type: 'api',
    name: 'taco_server',
    repo: 'Caleydo/taco_server',
    branch: 'deploy',
    additional: [{
      repo: 'phovea/phovea_data_hdf',
      branch: 'docker_env'
    }]
  }
];
